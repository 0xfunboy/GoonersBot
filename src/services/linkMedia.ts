import { mkdir, rm, stat, copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Context as GrammyContext } from 'grammy';
import type { ChatContext, Person } from '../domain/types.js';
import type { Storage } from '../storage/index.js';
import type { MediaProcessor } from '../providers/media/index.js';
import type { LinkMediaConfig } from '../config/index.js';
import { Cooldown } from '../utils/rateLimit.js';
import { childLogger } from '../utils/logger.js';
import { extractUrls, hostOf } from '../providers/media/linkMedia/url.js';
import { pickExtractor } from '../providers/media/linkMedia/registry.js';
import { downloadToFile } from '../providers/media/linkMedia/http.js';
import {
  normalizeAudio,
  normalizeGifAsMp4,
  normalizeVideo,
} from '../providers/media/linkMedia/normalizer.js';
import { sendPreparedMedia, sendCachedMedia } from '../providers/media/linkMedia/telegramSender.js';
import { downloadWithYtdlp } from '../providers/media/linkMedia/ytdlp.js';
import type { ExtractedMediaPost, LinkMediaKind } from '../providers/media/linkMedia/types.js';

const log = childLogger('link-media');

// Adult hosts skipped unless LINK_MEDIA_NSFW_ALLOW=true (moderation/legal risk, out of MVP scope).
const NSFW_HOSTS = [
  'pornhub.com',
  'xvideos.com',
  'xhamster.com',
  'redtube.com',
  'youporn.com',
  'onlyfans.com',
  'rule34.xxx',
  'e621.net',
  'spankbang.com',
];

export interface LinkMediaResult {
  handled: boolean;
  injectedText?: string;
}

export class LinkMediaService {
  private readonly chatCooldown: Cooldown;
  private readonly userCooldown: Cooldown;

  constructor(
    private readonly cfg: LinkMediaConfig,
    private readonly storage: Storage,
    private readonly media: MediaProcessor,
  ) {
    this.chatCooldown = new Cooldown(cfg.chatCooldownSeconds * 1000);
    this.userCooldown = new Cooldown(cfg.userCooldownSeconds * 1000);
  }

  get enabled(): boolean {
    return this.cfg.enabled && this.cfg.autoRehost && this.cfg.ffmpegAvailable;
  }

  async handleMessage(input: {
    ctx: GrammyContext;
    person: Person;
    context: ChatContext;
    text: string;
    addressed: boolean;
  }): Promise<LinkMediaResult> {
    if (!this.enabled) return { handled: false };

    const urls = extractUrls(input.text, this.cfg.maxUrlsPerMessage).filter((u) => this.hostAllowed(u));
    if (urls.length === 0) return { handled: false };

    // Anti-spam: one rehost burst per chat/user window.
    if (!this.chatCooldown.tryAcquire(String(input.context.chatId))) return { handled: false };
    if (!this.userCooldown.tryAcquire(input.person.userHandle)) return { handled: false };

    const injected: string[] = [];
    let sentAny = false;

    for (const url of urls) {
      const result = await this.processUrl(input.ctx, url, input.context.messageId, input.addressed).catch(
        (err) => {
          log.warn({ err, url: url.toString() }, 'link media processing failed');
          return null;
        },
      );
      if (!result) continue;
      sentAny = true;
      if (result.contextText) injected.push(result.contextText);
    }

    return {
      handled: sentAny,
      ...(injected.length ? { injectedText: injected.join('\n') } : {}),
    };
  }

  private hostAllowed(url: URL): boolean {
    const host = hostOf(url);
    if (this.cfg.blockedHosts.some((h) => host === h || host.endsWith(`.${h}`))) return false;
    if (this.cfg.allowedHosts.length > 0 && !this.cfg.allowedHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
      return false;
    }
    if (!this.cfg.nsfwAllow && NSFW_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return false;
    return true;
  }

  private cookieFor(host: string): string | undefined {
    if (/instagram\.com$/.test(host)) return this.cfg.cookies.instagram;
    if (/tiktok\.com$/.test(host)) return this.cfg.cookies.tiktok;
    if (/facebook\.com$/.test(host) || host === 'fb.watch') return this.cfg.cookies.facebook;
    if (/(^|\.)x\.com$/.test(host) || /twitter\.com$/.test(host)) return this.cfg.cookies.x;
    return undefined;
  }

  private async processUrl(
    ctx: GrammyContext,
    url: URL,
    replyToMessageId: number | undefined,
    addressed: boolean,
  ): Promise<{ contextText?: string } | null> {
    const key = this.cacheKey(url.toString());
    const cached = await this.storage.linkMediaCache.get(key);
    if (cached) {
      await this.storage.linkMediaCache.touch(key);
      await sendCachedMedia(
        ctx,
        cached.kind,
        cached.telegramFileId,
        cached.caption,
        replyToMessageId,
      ).catch((err) => log.warn({ err }, 'cached media send failed'));
      const ctxText = cached.transcript || cached.visionSummary;
      return ctxText ? { contextText: ctxText } : {};
    }

    const host = hostOf(url);
    const cookies = this.cookieFor(host);
    const extractor = pickExtractor(url);
    const post = await extractor.extract(url, {
      timeoutMs: this.cfg.timeoutMs,
      userAgent: this.cfg.userAgent,
      maxMediaPerUrl: this.cfg.maxMediaPerUrl,
      proxy: this.cfg.proxy,
      cookies,
    });
    if (!post || post.items.length === 0) return null;

    const item = post.items[0];
    if (!item) return null;
    if (item.durationSeconds && item.durationSeconds > this.cfg.maxDurationSeconds) return null;

    const workdir = join(this.cfg.tmpDir, randomBytes(8).toString('hex'));
    await mkdir(workdir, { recursive: true });

    try {
      const opts = {
        ffmpegBin: this.cfg.ffmpegBin,
        timeoutMs: this.cfg.timeoutMs,
        maxUploadBytes: this.cfg.maxUploadBytes,
      };
      let prepared: string;
      let sendKind: LinkMediaKind = item.kind;
      let durationSec = item.durationSeconds;

      if (item.via === 'ytdlp') {
        // Video streams (YouTube, TikTok, adult/cam, reddit video): download+merge with yt-dlp.
        if (!this.cfg.ytdlpAvailable) return null;
        const dl = await downloadWithYtdlp(item.url, workdir, {
          ytdlpBin: this.cfg.ytdlpBin,
          ffmpegBin: this.cfg.ffmpegBin,
          maxDownloadBytes: this.cfg.maxDownloadBytes,
          maxDurationSeconds: this.cfg.maxDurationSeconds,
          timeoutMs: this.cfg.timeoutMs,
          proxy: this.cfg.proxy,
          cookies,
        });
        if (!dl) return null;
        durationSec = dl.durationSec ?? durationSec;
        if (durationSec && durationSec > this.cfg.maxDurationSeconds) return null;
        if (!post.title && dl.title) post.title = dl.title;
        sendKind = 'video';
        // yt-dlp already produced a merged mp4; only re-encode if it exceeds the upload cap.
        const rawSize = (await stat(dl.file)).size;
        if (rawSize <= this.cfg.maxUploadBytes) {
          prepared = dl.file;
        } else {
          prepared = join(workdir, 'prepared.mp4');
          await normalizeVideo(dl.file, prepared, opts);
        }
      } else {
        const raw = join(workdir, `raw.${item.ext ?? 'bin'}`);
        const referer = post.webpageUrl || post.canonicalUrl || url.toString();
        await downloadToFile(item.url, raw, {
          timeoutMs: this.cfg.timeoutMs,
          maxBytes: this.cfg.maxDownloadBytes,
          userAgent: this.cfg.userAgent,
          headers: {
            referer,
            ...(cookies ? { cookie: cookies } : {}),
            ...(item.headers ?? {}),
          },
        });
        prepared = join(
          workdir,
          item.kind === 'audio'
            ? 'prepared.mp3'
            : item.kind === 'gif' || item.kind === 'video'
              ? 'prepared.mp4'
              : `prepared.${item.ext ?? 'bin'}`,
        );
        if (item.kind === 'video') await normalizeVideo(raw, prepared, opts);
        else if (item.kind === 'gif') {
          await normalizeGifAsMp4(raw, prepared, opts);
          sendKind = 'gif';
        } else if (item.kind === 'audio') await normalizeAudio(raw, prepared, opts);
        else await copyFile(raw, prepared);
      }

      const size = (await stat(prepared)).size;
      if (size > this.cfg.maxUploadBytes) return null;

      let contextText: string | undefined;
      const wantComment =
        this.cfg.aiCommentEnabled &&
        (addressed || !this.cfg.commentOnlyWhenAddressed) &&
        (!durationSec || durationSec <= this.cfg.aiMaxDurationSeconds);
      if (wantComment) {
        contextText = await this.enrichContext(prepared, sendKind);
      }

      const caption = this.buildCaption(post);
      const telegramFileId = await sendPreparedMedia({
        ctx,
        kind: sendKind,
        path: prepared,
        caption,
        replyToMessageId,
      });
      // Context the brain receives: the post's own text/stats plus any AI transcript/vision summary.
      const brainContext = [post.caption, contextText].filter(Boolean).join(' | ') || undefined;
      if (!telegramFileId) return brainContext ? { contextText: brainContext } : {};

      const now = new Date();
      const isAv = sendKind === 'audio' || sendKind === 'video';
      const isVisual = sendKind === 'image' || sendKind === 'gif' || sendKind === 'video';
      await this.storage.linkMediaCache.upsert({
        key,
        url: url.toString(),
        canonicalUrl: post.canonicalUrl,
        ...(post.contentId ? { contentId: post.contentId } : {}),
        platform: post.platform,
        kind: sendKind,
        telegramFileId,
        ...(caption ? { caption } : {}),
        byteSize: size,
        ...(durationSec ? { durationSeconds: durationSec } : {}),
        ...(isAv && contextText ? { transcript: contextText } : {}),
        ...(isVisual && contextText ? { visionSummary: contextText } : {}),
        createdAt: now,
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + this.cfg.cacheTtlDays * 86400_000),
      });

      return brainContext ? { contextText: brainContext } : {};
    } finally {
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async enrichContext(path: string, kind: LinkMediaKind): Promise<string | undefined> {
    try {
      const buf = await readFile(path);
      if (kind === 'audio') {
        return (await this.media.transcribeVoice(buf, 'audio/mpeg')) ?? undefined;
      }
      if (kind === 'video' || kind === 'gif') {
        const frame = await this.media.frameFromVideo(buf);
        if (!frame) return undefined;
        return (await this.media.describeImage(frame, 'image/jpeg')) ?? undefined;
      }
      if (kind === 'image') {
        return (await this.media.describeImage(buf, 'image/jpeg')) ?? undefined;
      }
    } catch (err) {
      log.debug({ err }, 'enrichContext failed');
    }
    return undefined;
  }

  private buildCaption(post: ExtractedMediaPost): string | undefined {
    // Social extractors already bake the rich context (text + likes/reposts) into post.caption.
    if (post.caption) return post.caption.slice(0, 1000);
    const parts: string[] = [];
    if (post.title) parts.push(post.title.slice(0, 200));
    if (post.author) parts.push(`by ${post.author}`);
    const caption = parts.join('\n').trim();
    return caption ? caption.slice(0, 1000) : undefined;
  }

  private cacheKey(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
