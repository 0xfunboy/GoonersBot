import { copyFile, lstat, mkdir, readFile, readdir, rm, rmdir, stat } from 'node:fs/promises';
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
import { createAbortScope } from '../utils/abort.js';
import {
  extractUrls,
  hostOf,
  mediaUrlKey,
  normalizeMediaUrl,
} from '../providers/media/linkMedia/url.js';
import { isSafeYtdlpFallback, pickExtractor } from '../providers/media/linkMedia/registry.js';
import { ytdlpExtractor } from '../providers/media/linkMedia/extractors/ytdlpSites.js';
import { isNsfwHost } from '../providers/media/linkMedia/hosts.js';
import { cookieHeaderForUrl } from '../providers/media/linkMedia/cookies.js';
import { genericHtmlExtractor } from '../providers/media/linkMedia/genericHtmlExtractor.js';
import { downloadToFile } from '../providers/media/linkMedia/http.js';
import {
  normalizeAudio,
  normalizeGifAsMp4,
  normalizeVideo,
  remuxFaststart,
  probeVideo,
  isTelegramCompatibleVideo,
  videoThumbnail,
} from '../providers/media/linkMedia/normalizer.js';
import { extractVideoFrame } from '../providers/voice/ffmpeg.js';
import {
  sendPreparedMedia,
  sendCachedMedia,
  type VideoMeta,
} from '../providers/media/linkMedia/telegramSender.js';
import {
  downloadManyWithYtdlp,
  downloadWithYtdlp,
  snapshotStream,
  type YtdlpDownloadConfig,
} from '../providers/media/linkMedia/ytdlp.js';
import type {
  ExtractedMediaItem,
  ExtractedMediaPost,
  LinkMediaKind,
} from '../providers/media/linkMedia/types.js';

const log = childLogger('link-media');
const MIN_STALE_RUN_AGE_MS = 15 * 60_000;

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
  /** Normalized source URLs successfully delivered; prevents a second tool-driven rehost. */
  handledUrls?: string[];
  /** URLs claimed by the interceptor for this turn, whether delivery succeeded or not. */
  attemptedUrls?: string[];
  /** Recognized media URLs that exhausted their bounded extraction/download fallbacks. */
  failedUrls?: string[];
  /** Safe operational reason for logs/debugging; never contains cookies or source internals. */
  reason?: string;
}

type ItemProcessingResult =
  | {
      status: 'sent';
      contextTexts: string[];
      messageIds: number[];
      partialFailure?: boolean;
    }
  | { status: 'skipped' | 'quota_denied' };

interface ProcessedUrlResult {
  contextText?: string;
  messageIds: number[];
  /** Extraction found concrete media, even if every delivery attempt failed. */
  mediaDetected?: boolean;
  /** At least one item in a multi-media post could not be delivered. */
  partialFailure?: boolean;
}

export class LinkMediaService {
  private readonly chatCooldown: Cooldown;
  private readonly userCooldown: Cooldown;
  private readonly instanceTmpDir: string;
  private readonly tmpReady: Promise<void>;
  private readonly shutdownController = new AbortController();
  private readonly activeJobs = new Set<Promise<ProcessedUrlResult | null>>();

  constructor(
    private readonly cfg: LinkMediaConfig,
    private readonly storage: Storage,
    private readonly media: MediaProcessor,
    private readonly quota: GroupQuotaService,
  ) {
    this.chatCooldown = new Cooldown(cfg.chatCooldownSeconds * 1000);
    this.userCooldown = new Cooldown(cfg.userCooldownSeconds * 1000);
    // Never recursively remove the configured root: a typo there could target unrelated data, and
    // an un-awaited boot sweep raced the first download. Each process owns a unique scratch subtree.
    this.instanceTmpDir = join(cfg.tmpDir, `run-${process.pid}-${randomBytes(6).toString('hex')}`);
    this.tmpReady = prepareInstanceTmp(
      cfg.tmpDir,
      this.instanceTmpDir,
      Math.max(MIN_STALE_RUN_AGE_MS, cfg.timeoutMs * 2),
    );
  }

  get enabled(): boolean {
    return this.cfg.enabled && this.cfg.ffmpegAvailable;
  }

  get autoRehostEnabled(): boolean {
    return this.enabled && this.cfg.autoRehost;
  }

  /** Abort downloads/transcodes, wait for their finally blocks, then remove this process' scratch. */
  async shutdown(): Promise<void> {
    if (!this.shutdownController.signal.aborted) {
      this.shutdownController.abort(new Error('link-media service shutting down'));
    }
    await this.tmpReady.catch(() => undefined);
    const jobs = [...this.activeJobs];
    if (jobs.length > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(jobs),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 10_000);
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    if (this.activeJobs.size === 0) {
      await rm(this.instanceTmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async handleMessage(input: {
    ctx: GrammyContext;
    person: Person;
    context: ChatContext;
    text: string;
    addressed: boolean;
    quotaBypass?: boolean;
    signal?: AbortSignal;
  }): Promise<LinkMediaResult> {
    if (!this.autoRehostEnabled) return { handled: false, reason: 'service_disabled' };

    const urls = extractUrls(input.text, this.cfg.maxUrlsPerMessage).filter((u) =>
      this.hostAllowed(u),
    );
    if (urls.length === 0) return { handled: false, reason: 'no_supported_url' };
    const recognizedUrls = urls.filter((url) => this.isRecognizedMediaUrl(url)).map(String);

    // Anti-spam: one rehost burst per chat/user window.
    if (!input.quotaBypass && !this.chatCooldown.tryAcquire(String(input.context.chatId))) {
      return {
        handled: false,
        reason: 'chat_cooldown',
        attemptedUrls: urls.map(String),
        ...(recognizedUrls.length ? { failedUrls: recognizedUrls } : {}),
      };
    }
    if (!input.quotaBypass && !this.userCooldown.tryAcquire(input.person.userHandle)) {
      return {
        handled: false,
        reason: 'user_cooldown',
        attemptedUrls: urls.map(String),
        ...(recognizedUrls.length ? { failedUrls: recognizedUrls } : {}),
      };
    }

    const injected: string[] = [];
    const messageIds: number[] = [];
    const handledUrls: string[] = [];
    const attemptedUrls: string[] = [];
    const failedUrls: string[] = [];
    let sentAny = false;

    for (const url of urls) {
      attemptedUrls.push(url.toString());
      const result = await this.processUrl(
        input.ctx,
        url,
        input.context.chatId,
        input.context.messageId,
        input.addressed,
        input.quotaBypass ?? false,
        input.signal,
      ).catch((err) => {
        log.warn({ err, url: safeUrlForLog(url) }, 'link media processing failed');
        return null;
      });
      if (!result || result.messageIds.length === 0) {
        if (result?.mediaDetected || this.isRecognizedMediaUrl(url))
          failedUrls.push(url.toString());
        continue;
      }
      sentAny = true;
      handledUrls.push(url.toString());
      if (result.partialFailure) failedUrls.push(url.toString());
      if (result.contextText) injected.push(result.contextText);
      messageIds.push(...result.messageIds);
    }

    const outcome: LinkMediaResult = {
      handled: sentAny,
      ...(injected.length ? { injectedText: injected.join('\n') } : {}),
      ...(messageIds.length ? { messageIds: [...new Set(messageIds)] } : {}),
      ...(handledUrls.length ? { handledUrls } : {}),
      ...(attemptedUrls.length ? { attemptedUrls } : {}),
      ...(failedUrls.length ? { failedUrls } : {}),
    };
    if (!sentAny) outcome.reason = failedUrls.length ? 'download_failed' : 'no_media_rehosted';
    return outcome;
  }

  async rehostUrl(input: {
    ctx: GrammyContext;
    context: ChatContext;
    url: string | URL;
    addressed: boolean;
    quotaBypass?: boolean;
    signal?: AbortSignal;
  }): Promise<LinkMediaResult> {
    if (!this.enabled) return { handled: false };
    const url = input.url instanceof URL ? input.url : safeUrl(input.url);
    if (!url || !this.hostAllowed(url)) return { handled: false };
    const result = await this.processUrl(
      input.ctx,
      url,
      input.context.chatId,
      input.context.messageId,
      input.addressed,
      input.quotaBypass ?? false,
      input.signal,
    ).catch((err) => {
      log.warn({ err, url: safeUrlForLog(url) }, 'explicit link media processing failed');
      return null;
    });
    if (!result || result.messageIds.length === 0) return { handled: false };
    return {
      handled: true,
      ...(result.contextText ? { injectedText: result.contextText } : {}),
      ...(result.messageIds.length ? { messageIds: result.messageIds } : {}),
      handledUrls: [url.toString()],
    };
  }

  private hostAllowed(url: URL): boolean {
    return this.hostNameAllowed(hostOf(url));
  }

  private hostNameAllowed(host: string): boolean {
    if (this.cfg.blockedHosts.some((candidate) => hostMatches(host, candidate))) return false;
    if (
      this.cfg.allowedHosts.length > 0 &&
      !this.cfg.allowedHosts.some((candidate) => hostMatches(host, candidate))
    ) {
      return false;
    }
    if (!this.cfg.nsfwAllow && isNsfwHost(host)) return false;
    return true;
  }

  private cookieFor(host: string): string | undefined {
    const fallback = this.cfg.cookies.default;
    if (hostMatches(host, 'instagram.com') || hostMatches(host, 'instagr.am'))
      return this.cfg.cookies.instagram ?? fallback;
    if (hostMatches(host, 'tiktok.com')) return this.cfg.cookies.tiktok ?? fallback;
    if (hostMatches(host, 'facebook.com') || hostMatches(host, 'fb.watch'))
      return this.cfg.cookies.facebook ?? fallback;
    if (
      hostMatches(host, 'x.com') ||
      hostMatches(host, 'twitter.com') ||
      hostMatches(host, 'fxtwitter.com') ||
      hostMatches(host, 'vxtwitter.com') ||
      hostMatches(host, 'fixupx.com')
    )
      return this.cfg.cookies.x ?? fallback;
    if (
      hostMatches(host, 'youtube.com') ||
      hostMatches(host, 'youtu.be') ||
      hostMatches(host, 'youtube-nocookie.com')
    )
      return this.cfg.cookies.youtube ?? fallback;
    return fallback;
  }

  private isRecognizedMediaUrl(url: URL): boolean {
    const options = { extraYtdlpHosts: this.cfg.extraYtdlpHosts };
    return isSafeYtdlpFallback(url, options) || pickExtractor(url, options).platform !== 'generic';
  }

  private async processUrl(
    ctx: GrammyContext,
    url: URL,
    chatId: number,
    replyToMessageId: number | undefined,
    addressed: boolean,
    quotaBypass: boolean,
    signal?: AbortSignal,
  ): Promise<ProcessedUrlResult | null> {
    const parentSignal = signal
      ? AbortSignal.any([signal, this.shutdownController.signal])
      : this.shutdownController.signal;
    const deadline = createAbortScope(this.cfg.timeoutMs, parentSignal, 'link-media URL');
    const job = this.processUrlWithinDeadline(
      ctx,
      url,
      chatId,
      replyToMessageId,
      addressed,
      quotaBypass,
      deadline.signal,
    );
    this.activeJobs.add(job);
    try {
      return await job;
    } finally {
      this.activeJobs.delete(job);
      deadline.dispose();
    }
  }

  private async processUrlWithinDeadline(
    ctx: GrammyContext,
    url: URL,
    chatId: number,
    replyToMessageId: number | undefined,
    addressed: boolean,
    quotaBypass: boolean,
    signal: AbortSignal,
  ): Promise<ProcessedUrlResult | null> {
    const key = this.cacheKey(url.toString());
    const cached = await this.storage.linkMediaCache.get(key).catch((err) => {
      log.debug({ err }, 'link media cache read failed');
      return null;
    });
    if (cached) {
      if (
        (!this.cfg.nsfwAllow && cached.nsfw) ||
        (cached.mediaHost !== undefined && !this.hostNameAllowed(cached.mediaHost))
      ) {
        return null;
      }
      if (!quotaBypass && !(await this.quota.reserveMedia(chatId, cached.byteSize ?? 0)).allowed) {
        return null;
      }
      await this.storage.linkMediaCache
        .touch(key)
        .catch((err) => log.debug({ err }, 'link media cache touch failed'));
      let messageId: number | undefined;
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
        if (!quotaBypass) {
          await this.quota
            .releaseMedia(chatId, cached.byteSize ?? 0)
            .catch((releaseErr) => log.warn({ err: releaseErr }, 'media quota rollback failed'));
        }
        if (isInvalidTelegramFileReference(err)) {
          // Invalid file_ids are permanent. Evict and continue with a fresh download in the same
          // request; transient Telegram failures keep the cache and do not trigger an expensive
          // duplicate download.
          await this.storage.linkMediaCache.delete(key).catch(() => undefined);
        } else {
          return { messageIds: [], mediaDetected: true };
        }
      }
      if (messageId !== undefined) {
        const enrichment = cached.transcript || cached.visionSummary;
        const ctxText = [cached.caption, enrichment].filter(Boolean).join(' | ') || undefined;
        return ctxText
          ? { contextText: ctxText, messageIds: [messageId] }
          : { messageIds: [messageId] };
      }
    }

    if (!quotaBypass && !(await this.quota.canReserveMedia(chatId)).allowed) return null;

    const host = hostOf(url);
    const cookies = this.cookieFor(host);
    const extractorCookies = await cookieHeaderForUrl(cookies, url);
    const extractorContext = {
      timeoutMs: this.cfg.timeoutMs,
      userAgent: this.cfg.userAgent,
      maxMediaPerUrl: this.cfg.maxMediaPerUrl,
      proxy: this.cfg.proxy,
      cookies: extractorCookies,
      signal,
      validateUrl: (target: URL) => {
        if (!this.hostAllowed(target)) throw new Error('media URL blocked by content policy');
      },
    };
    const extractor = pickExtractor(url, { extraYtdlpHosts: this.cfg.extraYtdlpHosts });
    let post: ExtractedMediaPost | null = null;
    try {
      post = await extractor.extract(url, extractorContext);
    } catch (err) {
      log.debug(
        { err, platform: extractor.platform, url: safeUrlForLog(url) },
        'primary link extractor failed',
      );
    }
    // Native extractors preserve captions/galleries, but their public APIs occasionally fail. For
    // trusted social/video hosts, fall through once to yt-dlp rather than ending the request.
    if (
      (!post || post.items.length === 0) &&
      extractor !== ytdlpExtractor &&
      this.cfg.ytdlpAvailable &&
      isSafeYtdlpFallback(url, { extraYtdlpHosts: this.cfg.extraYtdlpHosts })
    ) {
      post = await ytdlpExtractor.extract(url, extractorContext);
    }
    if (
      !this.cfg.ytdlpAvailable &&
      post?.items.length &&
      post.items.every((item) => item.via === 'ytdlp')
    ) {
      try {
        const generic = await genericHtmlExtractor.extract(url, extractorContext);
        if (generic?.items.length) post = { ...generic, platform: post.platform };
      } catch (err) {
        log.debug(
          { err, platform: post.platform, url: safeUrlForLog(url) },
          'generic fallback without yt-dlp failed',
        );
      }
    }
    if (!post || post.items.length === 0) return null;

    const items = post.items.slice(0, this.cfg.maxMediaPerUrl);
    const contextTexts: string[] = [];
    const messageIds: number[] = [];
    let failedItems = 0;
    for (const [index, item] of items.entries()) {
      const result = await this.processExtractedItem({
        ctx,
        url,
        post,
        item,
        chatId,
        replyToMessageId,
        addressed,
        quotaBypass,
        // A URL cache represents exactly one Telegram file. Multi-item posts deliberately skip it
        // so a later hit cannot silently collapse a gallery to its first attachment.
        cacheKey: items.length === 1 ? key : undefined,
        includeCaption: messageIds.length === 0,
        signal,
      }).catch((err) => {
        log.warn(
          { err, index, platform: post.platform, url: safeUrlForLog(url) },
          'link media item processing failed',
        );
        return { status: 'skipped' } as ItemProcessingResult;
      });

      if (result.status === 'quota_denied') {
        failedItems += items.length - index;
        break;
      }
      if (result.status !== 'sent') {
        failedItems += 1;
        continue;
      }
      messageIds.push(...result.messageIds);
      contextTexts.push(...result.contextTexts);
      if (result.partialFailure) failedItems += 1;
    }

    if (messageIds.length === 0) return { messageIds, mediaDetected: true };
    const uniqueContext = [...new Set(contextTexts)];
    return uniqueContext.length > 0
      ? {
          contextText: uniqueContext.join('\n'),
          messageIds,
          ...(failedItems > 0 ? { partialFailure: true } : {}),
        }
      : { messageIds, ...(failedItems > 0 ? { partialFailure: true } : {}) };
  }

  private async processExtractedItem(input: {
    ctx: GrammyContext;
    url: URL;
    post: ExtractedMediaPost;
    item: ExtractedMediaItem;
    chatId: number;
    replyToMessageId: number | undefined;
    addressed: boolean;
    quotaBypass: boolean;
    cacheKey: string | undefined;
    includeCaption: boolean;
    signal: AbortSignal;
  }): Promise<ItemProcessingResult> {
    const { item, post, signal } = input;
    const itemUrl = safeUrl(item.url);
    if (!itemUrl || !this.hostAllowed(itemUrl)) return { status: 'skipped' };
    const streamManifest = isStreamManifest(item, itemUrl);
    if (
      streamManifest &&
      (!this.cfg.ytdlpAvailable ||
        !isSafeYtdlpFallback(itemUrl, { extraYtdlpHosts: this.cfg.extraYtdlpHosts }))
    ) {
      // HLS/DASH requires nested network access. Only the curated/explicit yt-dlp host policy may
      // cross that boundary; arbitrary generic pages remain on the redirect-guarded HTTP path.
      return { status: 'skipped' };
    }
    if (item.durationSeconds && item.durationSeconds > this.cfg.maxDurationSeconds) {
      return { status: 'skipped' };
    }
    if (
      !input.quotaBypass &&
      !(await this.quota.canReserveMedia(input.chatId, item.byteSize ?? 1)).allowed
    ) {
      return { status: 'quota_denied' };
    }

    await this.tmpReady;
    const workdir = join(this.instanceTmpDir, `job-${randomBytes(8).toString('hex')}`);
    await mkdir(workdir, { recursive: true, mode: 0o700 });

    try {
      const opts = {
        ffmpegBin: this.cfg.ffmpegBin,
        timeoutMs: this.cfg.timeoutMs,
        maxUploadBytes: this.cfg.maxUploadBytes,
        signal,
      };

      if (item.via === 'ytdlp' || streamManifest) {
        // Video streams (YouTube, TikTok, Instagram, adult/cam, reddit video): download+merge with yt-dlp.
        if (!this.cfg.ytdlpAvailable) return { status: 'skipped' };
        const ytcfg: YtdlpDownloadConfig = {
          ytdlpBin: this.cfg.ytdlpBin,
          ffmpegBin: this.cfg.ffmpegBin,
          maxDownloadBytes: this.cfg.maxDownloadBytes,
          maxDurationSeconds: this.cfg.maxDurationSeconds,
          timeoutMs: this.cfg.timeoutMs,
          proxy: this.cfg.proxy,
          cookies: cookieForUrl(item.url, (targetHost) => this.cookieFor(targetHost)),
          userAgent: this.cfg.userAgent,
          jsRuntime: this.cfg.ytdlpJsRuntime,
          impersonate: this.cfg.ytdlpImpersonate,
          bwrapBin: this.cfg.bwrapBin,
          signal,
          validateUrl: (target: URL) => {
            if (!this.hostAllowed(target)) throw new Error('media URL blocked by content policy');
          },
        };

        if (item.ytdlpMode === 'bounded_playlist') {
          const batch = await downloadManyWithYtdlp(
            item.url,
            workdir,
            ytcfg,
            this.cfg.maxMediaPerUrl,
          );
          if (batch) {
            const messageIds: number[] = [];
            const contextTexts: string[] = [];
            let failed = batch.partial;
            let quotaDenied = false;

            for (const dl of batch.items) {
              if (
                !input.quotaBypass &&
                !(await this.quota.canReserveMedia(input.chatId, 1)).allowed
              ) {
                quotaDenied = true;
                failed = true;
                break;
              }
              const previousTitle = post.title;
              try {
                const probe = await probeVideo(this.cfg.ffmpegBin, dl.file, 15_000, signal);
                const durationSec = dl.durationSec ?? probe.duration ?? item.durationSeconds;
                if (durationSec && durationSec > this.cfg.maxDurationSeconds) {
                  failed = true;
                  continue;
                }
                if (!post.title && dl.title) post.title = dl.title;
                const prepared = join(
                  workdir,
                  `prepared-${String(dl.sequence).padStart(5, '0')}.mp4`,
                );
                const rawSize = (await stat(dl.file)).size;
                if (rawSize <= this.cfg.maxUploadBytes && isTelegramCompatibleVideo(probe)) {
                  await remuxFaststart(dl.file, prepared, opts);
                } else {
                  await normalizeVideo(dl.file, prepared, opts);
                }
                const delivered = await this.deliverPreparedItem({
                  ...input,
                  prepared,
                  workdir,
                  sendKind: 'video',
                  durationSec,
                  finalMediaUrl: itemUrl,
                  cacheKey: undefined,
                  includeCaption: input.includeCaption && messageIds.length === 0,
                  assetSuffix: String(dl.sequence).padStart(5, '0'),
                });
                if (delivered.status === 'quota_denied') {
                  post.title = previousTitle;
                  quotaDenied = true;
                  failed = true;
                  break;
                }
                if (delivered.status !== 'sent') {
                  post.title = previousTitle;
                  failed = true;
                  continue;
                }
                messageIds.push(...delivered.messageIds);
                contextTexts.push(...delivered.contextTexts);
              } catch (err) {
                post.title = previousTitle;
                failed = true;
                log.warn(
                  { err, sequence: dl.sequence, platform: post.platform },
                  'yt-dlp carousel item processing failed',
                );
              }
            }

            if (messageIds.length > 0) {
              return {
                status: 'sent',
                messageIds,
                contextTexts,
                ...(failed || quotaDenied ? { partialFailure: true } : {}),
              };
            }
            if (quotaDenied) return { status: 'quota_denied' };
            return { status: 'skipped' };
          }
        }

        const dl =
          item.ytdlpMode === 'bounded_playlist'
            ? null
            : await downloadWithYtdlp(item.url, workdir, ytcfg);
        let prepared: string;
        let sendKind: LinkMediaKind;
        let durationSec = item.durationSeconds;
        if (dl) {
          const downloadedProbe = await probeVideo(this.cfg.ffmpegBin, dl.file, 15_000, signal);
          durationSec = dl.durationSec ?? downloadedProbe.duration ?? durationSec;
          if (durationSec && durationSec > this.cfg.maxDurationSeconds)
            return { status: 'skipped' };
          if (!post.title && dl.title) post.title = dl.title;
          sendKind = 'video';
          // A .mp4 extension alone does not make a Telegram-streamable file: VP9/AV1/Opus in an MP4
          // must be transcoded. Compatible H.264/AAC is only remuxed to move moov to the front.
          const rawSize = (await stat(dl.file)).size;
          prepared = join(workdir, 'prepared.mp4');
          if (rawSize <= this.cfg.maxUploadBytes && isTelegramCompatibleVideo(downloadedProbe)) {
            // keep quality/size, just move the moov atom to the front so Telegram streams it inline
            await remuxFaststart(dl.file, prepared, opts);
          } else {
            await normalizeVideo(dl.file, prepared, opts);
          }
        } else {
          // Couldn't download a bounded video (live stream / too long / blocked): grab one frame.
          const snap = await snapshotStream(item.url, workdir, ytcfg);
          if (!snap) return { status: 'skipped' };
          prepared = snap;
          sendKind = 'image';
        }
        return await this.deliverPreparedItem({
          ...input,
          prepared,
          workdir,
          sendKind,
          durationSec,
          finalMediaUrl: itemUrl,
          cacheKey: item.ytdlpMode === 'bounded_playlist' ? undefined : input.cacheKey,
          assetSuffix: 'single',
        });
      }

      const raw = join(workdir, `raw.${item.ext ?? 'bin'}`);
      const referer = post.webpageUrl || post.canonicalUrl || input.url.toString();
      const mediaCookie = await cookieHeaderForUrl(
        cookieForUrl(item.url, (targetHost) => this.cookieFor(targetHost)),
        item.url,
      );
      const downloaded = await downloadToFile(item.url, raw, {
        timeoutMs: this.cfg.timeoutMs,
        maxBytes: this.cfg.maxDownloadBytes,
        userAgent: this.cfg.userAgent,
        signal,
        allowedContentTypes: MEDIA_CONTENT_TYPES[item.kind],
        validateUrl: (target: URL) => {
          if (!this.hostAllowed(target)) throw new Error('media URL blocked by content policy');
        },
        headers: {
          referer,
          ...safeForwardHeaders(item.headers),
          ...(mediaCookie ? { cookie: mediaCookie } : {}),
        },
      });
      const finalMediaUrl = safeUrl(downloaded.finalUrl) ?? itemUrl;
      let durationSec = item.durationSeconds;
      if (item.kind === 'video' || item.kind === 'audio') {
        const rawProbe = await probeVideo(this.cfg.ffmpegBin, raw, 15_000, signal);
        durationSec = rawProbe.duration ?? durationSec;
        if (durationSec && durationSec > this.cfg.maxDurationSeconds) return { status: 'skipped' };
      }
      const prepared = join(
        workdir,
        item.kind === 'audio'
          ? 'prepared.mp3'
          : item.kind === 'gif' || item.kind === 'video'
            ? 'prepared.mp4'
            : `prepared.${item.ext ?? 'bin'}`,
      );
      let sendKind = item.kind;
      if (item.kind === 'video') await normalizeVideo(raw, prepared, opts);
      else if (item.kind === 'gif') {
        await normalizeGifAsMp4(raw, prepared, opts);
        sendKind = 'gif';
      } else if (item.kind === 'audio') await normalizeAudio(raw, prepared, opts);
      else await copyFile(raw, prepared);
      return await this.deliverPreparedItem({
        ...input,
        prepared,
        workdir,
        sendKind,
        durationSec,
        finalMediaUrl,
        assetSuffix: 'single',
      });
    } finally {
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
      // rmdir is intentionally non-recursive: it only removes our empty instance directory and
      // cannot race-delete another in-flight job.
      await rmdir(this.instanceTmpDir).catch(() => undefined);
    }
  }

  private async deliverPreparedItem(input: {
    ctx: GrammyContext;
    url: URL;
    post: ExtractedMediaPost;
    chatId: number;
    replyToMessageId: number | undefined;
    addressed: boolean;
    quotaBypass: boolean;
    cacheKey: string | undefined;
    includeCaption: boolean;
    signal: AbortSignal;
    prepared: string;
    workdir: string;
    sendKind: LinkMediaKind;
    durationSec: number | undefined;
    finalMediaUrl: URL;
    assetSuffix: string;
  }): Promise<ItemProcessingResult> {
    const size = (await stat(input.prepared)).size;
    if (size > this.cfg.maxUploadBytes) return { status: 'skipped' };
    if (!input.quotaBypass && !(await this.quota.reserveMedia(input.chatId, size)).allowed) {
      return { status: 'quota_denied' };
    }

    let contextText: string | undefined;
    const wantComment =
      this.cfg.aiCommentEnabled &&
      (input.addressed || !this.cfg.commentOnlyWhenAddressed) &&
      (!input.durationSec || input.durationSec <= this.cfg.aiMaxDurationSeconds);
    if (wantComment) contextText = await this.enrichContext(input.prepared, input.sendKind);

    let videoMeta: VideoMeta | undefined;
    if (input.sendKind === 'video') {
      const probe = await probeVideo(
        this.cfg.ffmpegBin,
        input.prepared,
        15_000,
        input.signal,
      ).catch(() => ({}));
      const thumbPath = join(input.workdir, `thumb-${input.assetSuffix}.jpg`);
      const okThumb = await videoThumbnail(
        this.cfg.ffmpegBin,
        input.prepared,
        thumbPath,
        20_000,
        input.signal,
      ).catch(() => false);
      videoMeta = { ...probe, ...(okThumb ? { thumbnailPath: thumbPath } : {}) };
    }

    const caption = input.includeCaption ? this.buildCaption(input.post) : undefined;
    let sentMedia;
    try {
      sentMedia = await sendPreparedMedia({
        ctx: input.ctx,
        kind: input.sendKind,
        path: input.prepared,
        caption,
        replyToMessageId: input.replyToMessageId,
        ...(videoMeta ? { video: videoMeta } : {}),
      });
    } catch (err) {
      if (!input.quotaBypass) {
        await this.quota
          .releaseMedia(input.chatId, size)
          .catch((releaseErr) => log.warn({ err: releaseErr }, 'media quota rollback failed'));
      }
      throw err;
    }

    const sendKind = sentMedia.kind;
    const brainContext = [caption, contextText].filter(Boolean).join(' | ') || undefined;
    if (sentMedia.fileId && input.cacheKey) {
      const now = new Date();
      const isAv = sendKind === 'audio' || sendKind === 'video';
      const isVisual = sendKind === 'image' || sendKind === 'gif' || sendKind === 'video';
      await this.storage.linkMediaCache
        .upsert({
          key: input.cacheKey,
          url: input.url.toString(),
          canonicalUrl: input.post.canonicalUrl,
          ...(input.post.contentId ? { contentId: input.post.contentId } : {}),
          platform: input.post.platform,
          mediaHost: hostOf(input.finalMediaUrl),
          nsfw: isNsfwHost(input.url) || isNsfwHost(input.finalMediaUrl),
          kind: sendKind,
          telegramFileId: sentMedia.fileId,
          ...(caption ? { caption } : {}),
          byteSize: size,
          ...(input.durationSec ? { durationSeconds: input.durationSec } : {}),
          ...(isAv && contextText ? { transcript: contextText } : {}),
          ...(isVisual && contextText ? { visionSummary: contextText } : {}),
          createdAt: now,
          lastUsedAt: now,
          expiresAt: new Date(now.getTime() + this.cfg.cacheTtlDays * 86400_000),
        })
        .catch((err) => log.debug({ err }, 'link media cache write failed'));
    }

    return {
      status: 'sent',
      messageIds: [sentMedia.messageId],
      contextTexts: brainContext ? [brainContext] : [],
    };
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
    // v3 excludes pre-carousel entries that represented only the first yt-dlp playlist item.
    const normalized = mediaUrlKey(value) ?? value;
    return createHash('sha256').update('link-media:v3\0').update(normalized).digest('hex');
  }
}

function safeUrl(value: string): URL | null {
  return normalizeMediaUrl(value);
}

function safeUrlForLog(value: string | URL): string {
  const url = value instanceof URL ? value : safeUrl(value);
  return url ? `${url.origin}${url.pathname}` : '[invalid-url]';
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

function isStreamManifest(item: ExtractedMediaItem, url: URL): boolean {
  const mime = item.mime?.split(';', 1)[0]?.trim().toLowerCase();
  return (
    /\.(?:m3u8|mpd)$/i.test(url.pathname) ||
    mime === 'application/vnd.apple.mpegurl' ||
    mime === 'application/x-mpegurl' ||
    mime === 'application/mpegurl' ||
    mime === 'application/dash+xml'
  );
}

function isInvalidTelegramFileReference(err: unknown): boolean {
  const record = err && typeof err === 'object' ? (err as Record<string, unknown>) : undefined;
  const message = [
    err instanceof Error ? err.message : '',
    typeof record?.['description'] === 'string' ? record['description'] : '',
  ]
    .join(' ')
    .toLowerCase();
  return /wrong file identifier|invalid file(?:_| )id|file(?:_| )reference|failed to get http url content/.test(
    message,
  );
}

async function prepareInstanceTmp(
  root: string,
  instance: string,
  staleAgeMs: number,
): Promise<void> {
  await mkdir(root, { recursive: true });
  const cutoff = Date.now() - staleAgeMs;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const match = /^run-(\d+)-[a-f0-9]{12}$/.exec(entry.name);
    const legacyJob = /^[a-f0-9]{16}$/.test(entry.name);
    if ((!match && !legacyJob) || !entry.isDirectory()) continue;
    const candidate = join(root, entry.name);
    if (candidate === instance) continue;
    const metadata = await lstat(candidate).catch(() => null);
    if (!metadata?.isDirectory() || metadata.isSymbolicLink() || metadata.mtimeMs > cutoff)
      continue;
    if (match) {
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid < 2 || processIsAlive(pid)) continue;
    }
    await rm(candidate, { recursive: true, force: true }).catch((err) =>
      log.debug({ err }, 'stale link-media scratch cleanup failed'),
    );
  }
  await mkdir(instance, { recursive: true, mode: 0o700 });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
