import { mkdir, rm, stat, copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Context as GrammyContext } from 'grammy';
import type { ChatContext, Person } from '../domain/types.js';
import type { Storage } from '../storage/index.js';
import type { MediaProcessor } from '../providers/media/index.js';
import type { LinkMediaConfig } from '../config/index.js';
import type { GroupQuotaService } from './groupQuota.js';
import { Cooldown } from '../utils/rateLimit.js';
import { childLogger } from '../utils/logger.js';
import { extractUrls, hostOf } from '../providers/media/linkMedia/url.js';
import { pickExtractor } from '../providers/media/linkMedia/registry.js';
import { downloadToFile } from '../providers/media/linkMedia/http.js';
import {
  normalizeAudio,
  normalizeGifAsMp4,
  normalizeVideo,
  remuxFaststart,
  probeVideo,
  videoThumbnail,
} from '../providers/media/linkMedia/normalizer.js';
import { extractVideoFrame } from '../providers/voice/ffmpeg.js';
import {
  sendPreparedMedia,
  sendCachedMedia,
  type VideoMeta,
} from '../providers/media/linkMedia/telegramSender.js';
import { downloadWithYtdlp, snapshotStream } from '../providers/media/linkMedia/ytdlp.js';
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

const MEDIA_CONTENT_TYPES: Record<LinkMediaKind, readonly string[]> = {
  image: ['image/*', 'application/octet-stream'],
  gif: ['image/gif', 'image/*', 'application/octet-stream'],
  audio: ['audio/*', 'application/ogg', 'application/octet-stream'],
  video: [
    'video/*',
    'application/vnd.apple.mpegurl',
    'application/x-mpegurl',
    'application/dash+xml',
    'application/octet-stream',
  ],
  document: ['application/pdf', 'application/zip', 'application/octet-stream', 'text/plain'],
};

export interface LinkMediaResult {
  handled: boolean;
  injectedText?: string;
  /** Telegram delivery receipts, used to attach reactions to the complete turn. */
  messageIds?: number[];
  /** Safe operational reason for logs/debugging; never contains cookies or source internals. */
  reason?: string;
}

export class LinkMediaService {
  private readonly chatCooldown: Cooldown;
  private readonly userCooldown: Cooldown;

  constructor(
    private readonly cfg: LinkMediaConfig,
    private readonly storage: Storage,
    private readonly media: MediaProcessor,
    private readonly quota: GroupQuotaService,
  ) {
    this.chatCooldown = new Cooldown(cfg.chatCooldownSeconds * 1000);
    this.userCooldown = new Cooldown(cfg.userCooldownSeconds * 1000);
    // Best-effort sweep of leftover temp dirs from a previous crash (nothing is in flight at boot).
    void rm(cfg.tmpDir, { recursive: true, force: true }).catch(() => undefined);
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
    signal?: AbortSignal;
  }): Promise<LinkMediaResult> {
    if (!this.enabled) return { handled: false, reason: 'service_disabled' };

    const urls = extractUrls(input.text, this.cfg.maxUrlsPerMessage).filter((u) =>
      this.hostAllowed(u),
    );
    if (urls.length === 0) return { handled: false, reason: 'no_supported_url' };

    // Anti-spam: one rehost burst per chat/user window.
    if (!this.chatCooldown.tryAcquire(String(input.context.chatId))) {
      return { handled: false, reason: 'chat_cooldown' };
    }
    if (!this.userCooldown.tryAcquire(input.person.userHandle)) {
      return { handled: false, reason: 'user_cooldown' };
    }

    const injected: string[] = [];
    const messageIds: number[] = [];
    let sentAny = false;

    for (const url of urls) {
      if (!(await this.quota.reserve(input.context.chatId, 'media')).allowed) break;
      const result = await this.processUrl(
        input.ctx,
        url,
        input.context.chatId,
        input.context.messageId,
        input.addressed,
        input.signal,
      ).catch((err) => {
        log.warn({ err, url: url.toString() }, 'link media processing failed');
        return null;
      });
      if (!result) continue;
      sentAny = true;
      if (result.contextText) injected.push(result.contextText);
      messageIds.push(...result.messageIds);
    }

    const outcome: LinkMediaResult = {
      handled: sentAny,
      ...(injected.length ? { injectedText: injected.join('\n') } : {}),
      ...(messageIds.length ? { messageIds: [...new Set(messageIds)] } : {}),
    };
    if (!sentAny) outcome.reason = 'no_media_rehosted';
    return outcome;
  }

  async rehostUrl(input: {
    ctx: GrammyContext;
    context: ChatContext;
    url: string | URL;
    addressed: boolean;
    signal?: AbortSignal;
  }): Promise<LinkMediaResult> {
    if (!this.enabled) return { handled: false };
    const url = input.url instanceof URL ? input.url : safeUrl(input.url);
    if (!url || !this.hostAllowed(url)) return { handled: false };
    if (!(await this.quota.reserve(input.context.chatId, 'media')).allowed)
      return { handled: false };
    const result = await this.processUrl(
      input.ctx,
      url,
      input.context.chatId,
      input.context.messageId,
      input.addressed,
      input.signal,
    ).catch((err) => {
      log.warn({ err, url: url.toString() }, 'explicit link media processing failed');
      return null;
    });
    if (!result) return { handled: false };
    return {
      handled: true,
      ...(result.contextText ? { injectedText: result.contextText } : {}),
      ...(result.messageIds.length ? { messageIds: result.messageIds } : {}),
    };
  }

  private hostAllowed(url: URL): boolean {
    const host = hostOf(url);
    if (this.cfg.blockedHosts.some((candidate) => hostMatches(host, candidate))) return false;
    if (
      this.cfg.allowedHosts.length > 0 &&
      !this.cfg.allowedHosts.some((candidate) => hostMatches(host, candidate))
    ) {
      return false;
    }
    if (!this.cfg.nsfwAllow && NSFW_HOSTS.some((candidate) => hostMatches(host, candidate)))
      return false;
    return true;
  }

  private cookieFor(host: string): string | undefined {
    if (hostMatches(host, 'instagram.com')) return this.cfg.cookies.instagram;
    if (hostMatches(host, 'tiktok.com')) return this.cfg.cookies.tiktok;
    if (hostMatches(host, 'facebook.com') || hostMatches(host, 'fb.watch'))
      return this.cfg.cookies.facebook;
    if (hostMatches(host, 'x.com') || hostMatches(host, 'twitter.com')) return this.cfg.cookies.x;
    return undefined;
  }

  private async processUrl(
    ctx: GrammyContext,
    url: URL,
    chatId: number,
    replyToMessageId: number | undefined,
    addressed: boolean,
    signal?: AbortSignal,
  ): Promise<{ contextText?: string; messageIds: number[] } | null> {
    const key = this.cacheKey(url.toString());
    const cached = await this.storage.linkMediaCache.get(key);
    if (cached) {
      if (
        cached.byteSize &&
        !(await this.quota.reserve(chatId, 'media_bytes', cached.byteSize)).allowed
      ) {
        return null;
      }
      await this.storage.linkMediaCache.touch(key);
      let messageId: number;
      try {
        messageId = await sendCachedMedia(
          ctx,
          cached.kind,
          cached.telegramFileId,
          cached.caption,
          replyToMessageId,
        );
      } catch (err) {
        log.warn({ err }, 'cached media send failed');
        return null;
      }
      const ctxText = cached.transcript || cached.visionSummary;
      return ctxText
        ? { contextText: ctxText, messageIds: [messageId] }
        : { messageIds: [messageId] };
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
      signal,
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
        signal,
      };
      let prepared: string;
      let sendKind: LinkMediaKind = item.kind;
      let durationSec = item.durationSeconds;

      if (item.via === 'ytdlp') {
        // Video streams (YouTube, TikTok, Instagram, adult/cam, reddit video): download+merge with yt-dlp.
        if (!this.cfg.ytdlpAvailable) return null;
        const ytcfg = {
          ytdlpBin: this.cfg.ytdlpBin,
          ffmpegBin: this.cfg.ffmpegBin,
          maxDownloadBytes: this.cfg.maxDownloadBytes,
          maxDurationSeconds: this.cfg.maxDurationSeconds,
          timeoutMs: this.cfg.timeoutMs,
          proxy: this.cfg.proxy,
          cookies: cookieForUrl(item.url, (targetHost) => this.cookieFor(targetHost)),
          signal,
        };
        const dl = await downloadWithYtdlp(item.url, workdir, ytcfg);
        if (dl) {
          durationSec = dl.durationSec ?? durationSec;
          if (durationSec && durationSec > this.cfg.maxDurationSeconds) return null;
          if (!post.title && dl.title) post.title = dl.title;
          sendKind = 'video';
          // yt-dlp already produced a merged mp4; only re-encode if it exceeds the upload cap.
          const rawSize = (await stat(dl.file)).size;
          prepared = join(workdir, 'prepared.mp4');
          if (rawSize <= this.cfg.maxUploadBytes) {
            // keep quality/size, just move the moov atom to the front so Telegram streams it inline
            await remuxFaststart(dl.file, prepared, opts);
          } else {
            await normalizeVideo(dl.file, prepared, opts);
          }
        } else {
          // Couldn't download a bounded video (live stream / too long / blocked): grab one frame.
          const snap = await snapshotStream(item.url, workdir, ytcfg);
          if (!snap) return null;
          prepared = snap;
          sendKind = 'image';
        }
      } else {
        const raw = join(workdir, `raw.${item.ext ?? 'bin'}`);
        const referer = post.webpageUrl || post.canonicalUrl || url.toString();
        const mediaCookie = cookieForUrl(item.url, (targetHost) => this.cookieFor(targetHost));
        await downloadToFile(item.url, raw, {
          timeoutMs: this.cfg.timeoutMs,
          maxBytes: this.cfg.maxDownloadBytes,
          userAgent: this.cfg.userAgent,
          signal,
          allowedContentTypes: MEDIA_CONTENT_TYPES[item.kind],
          headers: {
            referer,
            ...safeForwardHeaders(item.headers),
            ...(mediaCookie ? { cookie: mediaCookie } : {}),
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
      if (!(await this.quota.reserve(chatId, 'media_bytes', size)).allowed) return null;

      let contextText: string | undefined;
      const wantComment =
        this.cfg.aiCommentEnabled &&
        (addressed || !this.cfg.commentOnlyWhenAddressed) &&
        (!durationSec || durationSec <= this.cfg.aiMaxDurationSeconds);
      if (wantComment) {
        contextText = await this.enrichContext(prepared, sendKind);
      }

      // For video, give Telegram a poster + dimensions + duration so it shows an inline,
      // autoplaying player instead of a downloadable file.
      let videoMeta: VideoMeta | undefined;
      if (sendKind === 'video') {
        const probe = await probeVideo(this.cfg.ffmpegBin, prepared, 15_000, signal).catch(
          () => ({}),
        );
        const thumbPath = join(workdir, 'thumb.jpg');
        const okThumb = await videoThumbnail(
          this.cfg.ffmpegBin,
          prepared,
          thumbPath,
          20_000,
          signal,
        ).catch(() => false);
        videoMeta = { ...probe, ...(okThumb ? { thumbnailPath: thumbPath } : {}) };
      }

      const caption = this.buildCaption(post);
      const sentMedia = await sendPreparedMedia({
        ctx,
        kind: sendKind,
        path: prepared,
        caption,
        replyToMessageId,
        ...(videoMeta ? { video: videoMeta } : {}),
      });
      const telegramFileId = sentMedia.fileId;
      // Context the brain receives: the post's own text/stats plus any AI transcript/vision summary.
      const brainContext = [post.caption, contextText].filter(Boolean).join(' | ') || undefined;
      if (!telegramFileId) {
        return brainContext
          ? { contextText: brainContext, messageIds: [sentMedia.messageId] }
          : { messageIds: [sentMedia.messageId] };
      }

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

      return brainContext
        ? { contextText: brainContext, messageIds: [sentMedia.messageId] }
        : { messageIds: [sentMedia.messageId] };
    } finally {
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async enrichContext(path: string, kind: LinkMediaKind): Promise<string | undefined> {
    try {
      if (kind === 'video' || kind === 'gif') {
        // extract one frame straight from the file (no loading the whole video into memory)
        const frame = await extractVideoFrame(this.cfg.ffmpegBin, path, this.cfg.timeoutMs);
        if (!frame.length) return undefined;
        return (await this.media.describeImage(frame, 'image/jpeg')) ?? undefined;
      }
      const buf = await readFile(path); // audio/image files are small
      if (kind === 'audio') {
        return (await this.media.transcribeVoice(buf, 'audio/mpeg')) ?? undefined;
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

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function normalizedHost(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\.+/, '')
    .replace(/\.$/, '')
    .replace(/^www\./, '');
}

function hostMatches(host: string, candidate: string): boolean {
  const normalized = normalizedHost(host);
  const suffix = normalizedHost(candidate);
  return Boolean(suffix) && (normalized === suffix || normalized.endsWith(`.${suffix}`));
}

function cookieForUrl(
  value: string,
  resolve: (host: string) => string | undefined,
): string | undefined {
  const url = safeUrl(value);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return undefined;
  return resolve(hostOf(url));
}

function safeForwardHeaders(headers?: Record<string, string>): Record<string, string> {
  if (!headers) return {};
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (/^(?:authorization|cookie|host|proxy-authorization)$/i.test(name)) continue;
    safe[name] = value;
  }
  return safe;
}
