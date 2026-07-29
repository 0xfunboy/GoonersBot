import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { childLogger } from '../../utils/logger.js';
import type { ImageResult, LLMProvider } from '../llm/types.js';
import type { ImageGenerationOptions, ImageGenerator } from '../image/stableDiffusion.js';
import type { SttProvider } from '../voice/stt.js';
import { extractVideoFrame, toVisionJpeg } from '../voice/ffmpeg.js';
import {
  assertMediaGenerationSafe,
  containsMinorMediaReference,
} from '../../safety/mediaSafety.js';
import { throwIfAborted } from '../../utils/abort.js';
import { fetchSafeRemoteBuffer } from '../../utils/safeRemoteFetch.js';

const log = childLogger('media');
const MAX_GENERATED_IMAGE_BYTES = 25 * 1024 * 1024;
const GENERATED_IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;

export interface FfmpegConfig {
  bin: string;
  available: boolean;
  timeoutMs: number;
}

export interface GeneratedImageQaConfig {
  enabled: boolean;
  /** 0..1 semantic-adherence threshold; hard failures always trigger the bounded retry. */
  minScore: number;
  maxRetries: number;
}

export interface VisionTextResult {
  text: string | null;
  visionCalls: number;
}

const generatedImageQaSchema = z.object({
  score: z.number().min(0).max(100),
  hardFailure: z.boolean(),
  ageSafety: z
    .enum(['adult_only', 'no_people', 'ambiguous_or_minor', 'not_assessed'])
    .default('not_assessed'),
  visibleContentRating: z
    .enum(['safe', 'suggestive', 'explicit', 'uncertain'])
    .default('uncertain'),
  visibleSummary: z.string().max(500).default(''),
  issues: z.array(z.string().min(1).max(240)).max(8).default([]),
  correction: z.string().max(600).default(''),
});

type GeneratedImageQa = z.infer<typeof generatedImageQaSchema>;

/**
 * MediaProcessor routes media through the active providers. Voice transcription prefers the local
 * whisper.cpp STT provider when enabled, falling back to the LLM provider's transcription endpoint.
 * Every method degrades gracefully (returns null + logs) so one missing capability never crashes.
 */
export class MediaProcessor {
  private imageTail: Promise<void> = Promise.resolve();
  constructor(
    private readonly llm: LLMProvider,
    private readonly stt?: SttProvider,
    private readonly ffmpeg?: FfmpegConfig,
    private readonly imageGenerator?: ImageGenerator,
    private readonly generatedImageQa?: GeneratedImageQaConfig,
  ) {}

  get canDescribeImage(): boolean {
    return this.llm.capabilities.vision && typeof this.llm.visionCompletion === 'function';
  }

  /** True if we can turn a video into a still frame for vision. */
  get canFrameVideo(): boolean {
    return Boolean(this.ffmpeg?.available);
  }

  /**
   * Extract one representative still frame (JPEG) from a video so it can be fed to the vision
   * model. Returns null when ffmpeg is unavailable or extraction fails.
   */
  async frameFromVideo(video: Buffer): Promise<Buffer | null> {
    if (!this.ffmpeg?.available) return null;
    const tmp = join(tmpdir(), `gb-frame-${randomBytes(6).toString('hex')}.bin`);
    try {
      await writeFile(tmp, video);
      const frame = await extractVideoFrame(this.ffmpeg.bin, tmp, this.ffmpeg.timeoutMs);
      return frame.length > 64 ? frame : null;
    } catch (err) {
      log.warn({ err }, 'video frame extraction failed');
      return null;
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }

  get canTranscribe(): boolean {
    return (
      Boolean(this.stt?.enabled) ||
      (this.llm.capabilities.transcription && typeof this.llm.transcribeAudio === 'function')
    );
  }

  get canGenerateImage(): boolean {
    return (
      Boolean(this.imageGenerator?.enabled) ||
      (this.llm.capabilities.imageGeneration && typeof this.llm.generateImage === 'function')
    );
  }

  /** Describe an image; returns null when vision is unavailable. Retries once if the model is flaky. */
  async describeImage(buffer: Buffer, mime: string, signal?: AbortSignal): Promise<string | null> {
    return (await this.describeImageWithUsage(buffer, mime, signal)).text;
  }

  /** Same description path with exact provider-call telemetry for pose/search consumers. */
  async describeImageWithUsage(
    buffer: Buffer,
    mime: string,
    signal?: AbortSignal,
  ): Promise<VisionTextResult> {
    if (!this.canDescribeImage || !this.llm.visionCompletion) {
      log.info('vision capability unavailable - skipping image description');
      return { text: null, visionCalls: 0 };
    }
    const visual = await this.prepareVisionImage(buffer, mime, signal);
    const imageBase64 = visual.buffer.toString('base64');
    let visionCalls = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        visionCalls += 1;
        const result = await this.llm.visionCompletion({
          prompt:
            'Describe what is actually in this image for chat context: the main subject, who/what ' +
            'it is, the setting, and anything notable. 1-2 sentences, concrete, no refusals.',
          imageBase64,
          imageMime: visual.mime,
          maxTokens: 220,
          signal,
        });
        const desc = result.text.trim();
        if (desc) return { text: desc, visionCalls };
        log.warn({ attempt }, 'image description empty, retrying');
      } catch (err) {
        throwIfAborted(signal);
        log.warn({ err, attempt }, 'image description failed');
      }
    }
    return { text: null, visionCalls };
  }

  /**
   * Identify the main subject of an image for reverse-image grounding: name the specific
   * person/character/product/brand if recognizable, plus a few search keywords. Returns a short
   * line suitable as a web-search query, or null when vision is unavailable/fails.
   */
  async identifyImage(buffer: Buffer, mime: string, signal?: AbortSignal): Promise<string | null> {
    if (!this.canDescribeImage || !this.llm.visionCompletion) return null;
    try {
      const visual = await this.prepareVisionImage(buffer, mime, signal);
      const result = await this.llm.visionCompletion({
        prompt:
          'Identify the MAIN subject of this image as precisely as possible. If it is a known ' +
          'person, fictional/anime character, brand, product or place, give its specific name. ' +
          'Reply with ONLY a short search query (name + 2-4 keywords), no sentences, no preamble.',
        imageBase64: visual.buffer.toString('base64'),
        imageMime: visual.mime,
        maxTokens: 60,
        signal,
      });
      const line = result.text.replace(/\s+/g, ' ').trim();
      return line.length > 1 ? line.slice(0, 120) : null;
    } catch (err) {
      log.warn({ err }, 'image identification failed');
      return null;
    }
  }

  /** Transcribe a voice message; prefers local whisper.cpp, then the LLM provider. */
  async transcribeVoice(
    buffer: Buffer,
    mime: string,
    opts: { fileName?: string; language?: string } = {},
  ): Promise<string | null> {
    if (this.stt?.enabled) {
      const local = await this.stt.transcribe(buffer, opts.language);
      if (local !== null) return local;
    }
    if (!this.llm.capabilities.transcription || typeof this.llm.transcribeAudio !== 'function') {
      log.info('transcription capability unavailable - skipping voice transcription');
      return null;
    }
    try {
      const req: { audio: Buffer; mime: string; fileName?: string } = { audio: buffer, mime };
      if (opts.fileName !== undefined) req.fileName = opts.fileName;
      const text = await this.llm.transcribeAudio(req);
      return text.trim() || null;
    } catch (err) {
      log.warn({ err }, 'voice transcription failed');
      return null;
    }
  }

  /** Generate an image; returns null when generation is unavailable or fails. */
  async generateImage(
    prompt: string,
    options: ImageGenerationOptions = {},
  ): Promise<ImageResult | null> {
    assertMediaGenerationSafe(prompt);
    throwIfAborted(options.signal);
    if (!this.canGenerateImage) {
      log.info('image generation capability unavailable - skipping');
      return null;
    }
    return this.runImageExclusive(async () => {
      try {
        const first = await this.generateRawImage(prompt, options);
        if (!first) return null;
        return await this.inspectAndMaybeRetryGeneratedImage(first, prompt, options);
      } catch (err) {
        log.warn({ err }, 'image generation failed');
        return null;
      }
    }, options.signal);
  }

  private async generateRawImage(
    prompt: string,
    options: ImageGenerationOptions,
  ): Promise<ImageResult | null> {
    if (this.imageGenerator?.enabled) {
      return this.imageGenerator.generate(prompt, options);
    }
    if (!this.llm.generateImage) return null;
    const naturalPrompt = [
      options.providerPrompts?.agnes ?? prompt,
      options.retryFeedback
        ? `Correction required after visual inspection: ${options.retryFeedback}.`
        : '',
    ]
      .filter(Boolean)
      .join(' ');
    assertMediaGenerationSafe(naturalPrompt);
    const result = await this.llm.generateImage({
      prompt: naturalPrompt,
      size: openAiImageSize(options.aspectRatio),
      signal: options.signal,
    });
    return this.materializeImageResult(result, options.signal);
  }

  private async materializeImageResult(
    result: ImageResult,
    signal?: AbortSignal,
  ): Promise<ImageResult> {
    if (result.buffer?.length) {
      if (result.buffer.length > MAX_GENERATED_IMAGE_BYTES) {
        throw new Error('generated image exceeded the byte limit');
      }
      return {
        ...result,
        mime: result.mime ?? detectImageMime(result.buffer),
      };
    }
    if (!result.url) throw new Error('image provider returned no bytes or URL');
    const inline = decodeGeneratedImageDataUrl(result.url);
    if (inline) {
      return { ...result, buffer: inline.buffer, mime: inline.mime };
    }
    const downloaded = await fetchSafeRemoteBuffer(result.url, {
      timeoutMs: GENERATED_IMAGE_DOWNLOAD_TIMEOUT_MS,
      maxBytes: MAX_GENERATED_IMAGE_BYTES,
      signal,
      allowedContentTypes: ['image/*'],
      headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8' },
    });
    if (!downloaded.buffer.length) throw new Error('generated image download was empty');
    return {
      ...result,
      buffer: downloaded.buffer,
      mime: downloaded.contentType || detectImageMime(downloaded.buffer),
    };
  }

  private async inspectAndMaybeRetryGeneratedImage(
    first: ImageResult,
    prompt: string,
    options: ImageGenerationOptions,
  ): Promise<ImageResult> {
    if (
      !this.generatedImageQa?.enabled ||
      !options.qualityBrief ||
      !first.buffer ||
      !this.canDescribeImage ||
      !this.llm.visionCompletion
    ) {
      if (options.rating === 'suggestive' || options.rating === 'explicit') {
        throw new Error('adult-only image generation requires visual age verification');
      }
      return {
        ...first,
        generationAttempts: first.generationAttempts ?? 1,
        qaVisionCalls: 0,
      };
    }

    let generationAttempts = first.generationAttempts ?? 1;
    let qaVisionCalls = 1;
    const requestedRating = options.rating ?? 'safe';
    const isAdultRated = requestedRating === 'suggestive' || requestedRating === 'explicit';
    const requireAdultOnly = isAdultRated && (options.expectsPeople ?? true);
    const firstQa = await this.inspectGeneratedImage(
      first.buffer,
      options.qualityBrief,
      requireAdultOnly,
      requestedRating,
      options.signal,
    );
    if (!firstQa) {
      if (requireAdultOnly) {
        throw new Error('adult-only generated image could not be visually safety-verified');
      }
      return { ...first, generationAttempts, qaVisionCalls };
    }
    let best = first;
    let bestQa = firstQa;
    this.logGeneratedImageQa(first, firstQa, 1);
    if (this.generatedImagePasses(firstQa)) {
      return withImageQaMeta(first, generationAttempts, qaVisionCalls, firstQa.score);
    }

    const retries = Math.max(0, Math.min(2, this.generatedImageQa.maxRetries));
    for (let retry = 0; retry < retries; retry += 1) {
      const correction = safeQaCorrection(bestQa);
      const preferredProvider =
        options.poseReference || options.rating === 'explicit'
          ? 'pony'
          : options.preferredProvider === 'agnes'
            ? 'agnes'
            : best.provider === 'pony' ||
                (best.provider === undefined && /pony|diffusion/i.test(best.model))
              ? 'agnes'
              : 'pony';
      try {
        const candidate = await this.generateRawImage(prompt, {
          ...options,
          preferredProvider,
          retryFeedback: correction,
        });
        if (!candidate) continue;
        generationAttempts += candidate.generationAttempts ?? 1;
        if (!candidate.buffer) continue;
        qaVisionCalls += 1;
        const candidateQa = await this.inspectGeneratedImage(
          candidate.buffer,
          options.qualityBrief,
          requireAdultOnly,
          requestedRating,
          options.signal,
        );
        if (!candidateQa) continue;
        this.logGeneratedImageQa(candidate, candidateQa, retry + 2);
        if (isBetterGeneratedImageQa(candidateQa, bestQa, requireAdultOnly, requestedRating)) {
          best = candidate;
          bestQa = candidateQa;
        }
        if (this.generatedImagePasses(candidateQa)) {
          return withImageQaMeta(candidate, generationAttempts, qaVisionCalls, candidateQa.score);
        }
      } catch (error) {
        generationAttempts += failedGenerationAttempts(error);
        log.warn(
          { error, retry: retry + 1, preferredProvider },
          'generated-image QA retry failed; keeping the best existing artifact',
        );
      }
    }
    log.warn(
      {
        model: best.model,
        score: bestQa.score,
        hardFailure: bestQa.hardFailure,
        issues: bestQa.issues,
      },
      'generated-image QA exhausted; returning the best candidate',
    );
    if (bestQa.ageSafety === 'ambiguous_or_minor') {
      throw new Error('generated image failed visual minor-safety verification');
    }
    if (requireAdultOnly && bestQa.ageSafety !== 'adult_only') {
      throw new Error('adult-only generated image failed visual age verification');
    }
    if (!contentRatingAllowed(bestQa.visibleContentRating, requestedRating)) {
      throw new Error('generated image exceeded the requested visual content rating');
    }
    return withImageQaMeta(best, generationAttempts, qaVisionCalls, bestQa.score);
  }

  private generatedImagePasses(qa: GeneratedImageQa): boolean {
    const threshold = Math.max(0, Math.min(1, this.generatedImageQa?.minScore ?? 0.72)) * 100;
    return !qa.hardFailure && qa.score >= threshold;
  }

  private async inspectGeneratedImage(
    buffer: Buffer,
    qualityBrief: string,
    requireAdultOnly: boolean,
    requestedRating: NonNullable<ImageGenerationOptions['rating']>,
    signal?: AbortSignal,
  ): Promise<GeneratedImageQa | null> {
    if (!this.llm.visionCompletion) return null;
    try {
      const visual = await this.prepareVisionImage(buffer, detectImageMime(buffer), signal, true);
      const result = await this.llm.visionCompletion({
        system:
          'You are a strict generated-image QA inspector. Judge only visible evidence against the ' +
          'given visual contract. Return only one minified JSON object.',
        prompt: [
          'TARGET VISUAL CONTRACT:',
          qualityBrief.slice(0, 3_000),
          '',
          'Return exactly: {"score":0-100,"hardFailure":boolean,"visibleSummary":"short",',
          '"ageSafety":"adult_only|no_people|ambiguous_or_minor",',
          '"visibleContentRating":"safe|suggestive|explicit|uncertain",',
          '"issues":["major mismatch"],"correction":"one focused instruction for a retry"}.',
          'hardFailure is true only for a missing/extra main subject, wrong subject type/count, wrong',
          'central action or interaction, clearly wrong medium/framing, illegible required exact text,',
          'severe anatomical corruption, or any apparently minor/teen/age-ambiguous person.',
          'Before scoring, verify each hard requirement separately. If one is visibly absent, set',
          'hardFailure=true. For full-body framing, both complete feet/shoes must be inside the',
          'canvas; cropped ankles or feet are a framing hard failure. For any directional rule,',
          "identify the depicted subject's left/right hands and the viewer-left/viewer-right image",
          'sides before deciding; a reversed hand/object placement is a hard failure.',
          'Classify visibleContentRating from visible pixels, never from the request: safe means no',
          'sexualized presentation or nudity; suggestive means sensual/lingerie/swimwear without',
          'visible genitals or sex acts; explicit means nudity, visible intimate anatomy or sex acts;',
          'uncertain means you cannot reliably decide.',
          `The requested maximum rating is ${requestedRating}. Content above that limit is a hard failure.`,
          'Use ageSafety=adult_only only when every visible person is unambiguously mature; use',
          'no_people for scenes without people and ambiguous_or_minor whenever uncertain.',
          'If the contract contains Required viewer-coordinate placement, those are final image',
          'coordinates: compare them literally and never mirror or reinterpret them. Only when no',
          "viewer-coordinate placement is supplied, interpret anatomical left/right from the depicted subject's perspective.",
          requireAdultOnly
            ? 'This is an adult-only request: ageSafety must be adult_only or the image must fail.'
            : requestedRating !== 'safe'
              ? 'This adult-rated request has no human subjects: use ageSafety=no_people unless a person is visibly present.'
              : 'Do not fail on harmless artistic variation.',
        ].join('\n'),
        imageBase64: visual.buffer.toString('base64'),
        imageMime: visual.mime,
        maxTokens: 320,
        signal,
      });
      let qa = parseGeneratedImageQa(result.text);
      if (qa && requireAdultOnly && qa.ageSafety !== 'adult_only') {
        qa = {
          ...qa,
          hardFailure: true,
          issues: [...new Set([...qa.issues, 'adult-only visual age could not be verified'])].slice(
            0,
            8,
          ),
        };
      }
      if (qa && !contentRatingAllowed(qa.visibleContentRating, requestedRating)) {
        qa = {
          ...qa,
          hardFailure: true,
          issues: [
            ...new Set([
              ...qa.issues,
              `visible ${qa.visibleContentRating} content exceeds requested ${requestedRating} rating`,
            ]),
          ].slice(0, 8),
          correction:
            requestedRating === 'safe'
              ? 'Regenerate fully clothed, non-sexualized safe content with no nudity.'
              : 'Regenerate without nudity, visible intimate anatomy or sexual acts.',
        };
      }
      if (!qa) {
        log.warn(
          { response: result.text.replace(/\s+/g, ' ').slice(0, 500) },
          'generated-image QA returned malformed structured output; keeping the artifact',
        );
      }
      return qa;
    } catch (error) {
      throwIfAborted(signal);
      log.warn({ error }, 'generated-image QA failed; keeping the generated artifact');
      return null;
    }
  }

  private logGeneratedImageQa(result: ImageResult, qa: GeneratedImageQa, attempt: number): void {
    log.info(
      {
        model: result.model,
        attempt,
        score: qa.score,
        hardFailure: qa.hardFailure,
        issues: qa.issues,
      },
      'generated-image QA completed',
    );
  }

  private async prepareVisionImage(
    buffer: Buffer,
    mime: string,
    signal?: AbortSignal,
    force = false,
  ): Promise<{ buffer: Buffer; mime: string }> {
    if ((!force && buffer.length <= 600_000) || !this.ffmpeg?.available) {
      return { buffer, mime };
    }
    try {
      const compact = await toVisionJpeg(
        this.ffmpeg.bin,
        buffer,
        Math.min(this.ffmpeg.timeoutMs, 30_000),
        signal,
      );
      if (compact.length > 0) return { buffer: compact, mime: 'image/jpeg' };
    } catch (error) {
      log.warn({ error, bytes: buffer.length }, 'vision image downscale failed');
    }
    return { buffer, mime };
  }

  /** Stable Diffusion is intentionally shared and strictly serial across every group. */
  private async runImageExclusive<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.imageTail.catch(() => undefined);
    let release: (() => void) | undefined;
    const ownGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Preserve the full queue chain even if this waiter aborts before its turn. Otherwise a later
    // request could leapfrog a still-running Forge job.
    this.imageTail = previous.then(() => ownGate);
    let onAbort: (() => void) | undefined;
    try {
      const waitForAbort = new Promise<never>((_resolve, reject) => {
        onAbort = (): void => {
          reject(signal?.reason instanceof Error ? signal.reason : new Error('image job aborted'));
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
      await Promise.race([previous, waitForAbort]);
      throwIfAborted(signal);
      return await task();
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      release?.();
    }
  }
}

function parseGeneratedImageQa(text: string): GeneratedImageQa | null {
  const json = text.replace(/```(?:json)?/gi, '').match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    const recovered = recoverGeneratedImageQaRecord(json);
    if (!recovered) return null;
    raw = recovered;
  }
  const score = Number(raw.score ?? raw.adherenceScore ?? raw.adherence_score);
  const hardRaw = raw.hardFailure ?? raw.hard_failure;
  const hardFailure =
    typeof hardRaw === 'boolean' ? hardRaw : /^(?:true|1|yes)$/i.test(String(hardRaw ?? ''));
  const issuesRaw = raw.issues ?? raw.problems;
  const issues = Array.isArray(issuesRaw)
    ? issuesRaw.map(String)
    : typeof issuesRaw === 'string'
      ? issuesRaw.split(/\n|;\s*/).filter(Boolean)
      : [];
  const parsed = generatedImageQaSchema.safeParse({
    score,
    hardFailure,
    ageSafety: normalizeAgeSafety(raw.ageSafety ?? raw.age_safety),
    visibleContentRating: normalizeVisibleContentRating(
      raw.visibleContentRating ?? raw.visible_content_rating ?? raw.contentRating,
    ),
    visibleSummary: String(raw.visibleSummary ?? raw.visible_summary ?? '').slice(0, 500),
    issues: issues.map((issue) => issue.slice(0, 240)).slice(0, 8),
    correction: String(raw.correction ?? raw.retryInstruction ?? '').slice(0, 600),
  });
  if (!parsed.success) return null;
  const normalized = qaIssuesImplyHardFailure(parsed.data.issues)
    ? { ...parsed.data, hardFailure: true }
    : parsed.data;
  if (normalized.ageSafety === 'ambiguous_or_minor') {
    return {
      ...normalized,
      hardFailure: true,
      issues: [
        ...new Set([
          ...normalized.issues,
          'one or more depicted people appear minor or age-ambiguous',
        ]),
      ].slice(0, 8),
    };
  }
  return normalized;
}

function qaIssuesImplyHardFailure(issues: string[]): boolean {
  return issues.some((issue) =>
    /\b(?:wrong subject count|missing (?:main )?subject|extra (?:person|people|subject|character|body|limb|arm|leg|finger)s?|missing fingers?|extra fingers?|deform(?:ed|ity)|severe anatom|unreadable|required text (?:is )?(?:missing|illegible)|wrong (?:central )?(?:action|interaction|medium|framing|pose)|incorrect (?:left|right|hand|side|direction)|left\/right (?:is )?(?:wrong|reversed)|reversed (?:hands?|sides?|left|right)|(?:hand|directional|side|left|right) positioning mismatch|(?:hand|directional|side|left|right) position inconsistent)\b/i.test(
      issue,
    ),
  );
}

/**
 * Some compact vision models occasionally omit one quote or the closing issues bracket. Recover
 * only the fixed QA scalar fields; this is deliberately not a general JSON repair/eval path.
 */
function recoverGeneratedImageQaRecord(json: string): Record<string, unknown> | null {
  const score = Number(
    json.match(/"(?:score|adherenceScore|adherence_score)"\s*:\s*"?(\d{1,3})/i)?.[1],
  );
  if (!Number.isFinite(score)) return null;
  const hard = json.match(/"(?:hardFailure|hard_failure)"\s*:\s*"?(true|false|1|0|yes|no)/i)?.[1];
  const issuesSection = json.match(
    /"(?:issues|problems)"\s*:\s*\[?([\s\S]*?)(?=,\s*"(?:correction|retryInstruction)"\s*:|\}\s*$)/i,
  )?.[1];
  const quotedIssues = [...(issuesSection ?? '').matchAll(/"((?:\\.|[^"\\])*)"/g)].map((match) =>
    decodeLooseJsonString(match[1] ?? ''),
  );
  const looseIssue =
    quotedIssues.length === 0
      ? (issuesSection ?? '')
          .replace(/^\s*["']?/, '')
          .replace(/["'\]\s]+$/, '')
          .trim()
      : '';
  return {
    score,
    hardFailure: /^(?:true|1|yes)$/i.test(hard ?? ''),
    ageSafety: looseJsonStringField(json, ['ageSafety', 'age_safety']),
    visibleContentRating: looseJsonStringField(json, [
      'visibleContentRating',
      'visible_content_rating',
      'contentRating',
    ]),
    visibleSummary: looseJsonStringField(json, ['visibleSummary', 'visible_summary']),
    issues: quotedIssues.length ? quotedIssues : looseIssue ? [looseIssue] : [],
    correction: looseJsonStringField(json, ['correction', 'retryInstruction']),
  };
}

function looseJsonStringField(json: string, names: string[]): string {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const value = json.match(new RegExp(`"${escaped}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'i'))?.[1];
    if (value !== undefined) return decodeLooseJsonString(value);
  }
  return '';
}

function decodeLooseJsonString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}

function safeQaCorrection(qa: GeneratedImageQa): string {
  const raw = [qa.correction, ...qa.issues].filter(Boolean).join('. ').slice(0, 900);
  if (!raw) return 'Match the exact requested subject count, action, framing and setting.';
  if (containsMinorMediaReference(raw)) {
    return 'Make every depicted person visibly mature adult; match the exact subject count, action, framing and setting.';
  }
  return raw.replace(/\s+/g, ' ').trim();
}

function isBetterGeneratedImageQa(
  candidate: GeneratedImageQa,
  current: GeneratedImageQa,
  requireAdultOnly: boolean,
  requestedRating: NonNullable<ImageGenerationOptions['rating']>,
): boolean {
  const candidateContentAllowed = contentRatingAllowed(
    candidate.visibleContentRating,
    requestedRating,
  );
  const currentContentAllowed = contentRatingAllowed(current.visibleContentRating, requestedRating);
  if (candidateContentAllowed !== currentContentAllowed) return candidateContentAllowed;
  const ageRank = (qa: GeneratedImageQa): number => {
    if (qa.ageSafety === 'ambiguous_or_minor') return 0;
    if (!requireAdultOnly) return 1;
    return qa.ageSafety === 'adult_only' ? 2 : 1;
  };
  if (ageRank(candidate) !== ageRank(current)) return ageRank(candidate) > ageRank(current);
  if (candidate.hardFailure !== current.hardFailure) return !candidate.hardFailure;
  return candidate.score > current.score;
}

function contentRatingAllowed(
  visible: GeneratedImageQa['visibleContentRating'],
  requested: NonNullable<ImageGenerationOptions['rating']>,
): boolean {
  if (visible === 'uncertain') return false;
  if (requested === 'explicit') return true;
  if (requested === 'suggestive') return visible !== 'explicit';
  return visible === 'safe';
}

function withImageQaMeta(
  result: ImageResult,
  generationAttempts: number,
  qaVisionCalls: number,
  qaScore?: number,
): ImageResult {
  return {
    ...result,
    generationAttempts,
    qaVisionCalls,
    ...(qaScore === undefined ? {} : { qaScore }),
  };
}

function detectImageMime(buffer: Buffer): string {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'))) {
    return 'image/gif';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(4, 8).toString('ascii') === 'ftyp' &&
    /^(?:avif|avis)$/.test(buffer.subarray(8, 12).toString('ascii'))
  ) {
    return 'image/avif';
  }
  return 'image/png';
}

function openAiImageSize(aspectRatio: ImageGenerationOptions['aspectRatio']): string {
  if (aspectRatio === '16:9') return '1792x1024';
  if (aspectRatio === '9:16') return '1024x1792';
  return '1024x1024';
}

function decodeGeneratedImageDataUrl(value: string): { buffer: Buffer; mime: string } | null {
  const match = value.match(/^data:(image\/[\w.+-]+);base64,([\s\S]+)$/i);
  if (!match?.[1] || !match[2]) return null;
  const encoded = match[2].replace(/\s+/g, '');
  if (encoded.length > Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4 + 4) {
    throw new Error('generated image data URL exceeded the byte limit');
  }
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length) throw new Error('generated image data URL was empty');
  if (buffer.length > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error('generated image data URL exceeded the byte limit');
  }
  return { buffer, mime: match[1].toLowerCase() };
}

function normalizeAgeSafety(value: unknown): GeneratedImageQa['ageSafety'] {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (normalized === 'adult_only' || normalized === 'adult') return 'adult_only';
  if (normalized === 'no_people' || normalized === 'no_person') return 'no_people';
  if (normalized === 'ambiguous_or_minor' || normalized === 'minor' || normalized === 'ambiguous') {
    return 'ambiguous_or_minor';
  }
  return 'not_assessed';
}

function normalizeVisibleContentRating(value: unknown): GeneratedImageQa['visibleContentRating'] {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (normalized === 'safe' || normalized === 'sfw') return 'safe';
  if (normalized === 'suggestive' || normalized === 'sensual') return 'suggestive';
  if (normalized === 'explicit' || normalized === 'nsfw' || normalized === 'adult') {
    return 'explicit';
  }
  return 'uncertain';
}

function failedGenerationAttempts(error: unknown): number {
  if (!error || typeof error !== 'object' || !('generationAttempts' in error)) return 1;
  const attempts = Number((error as { generationAttempts?: unknown }).generationAttempts);
  return Number.isFinite(attempts) ? Math.max(1, Math.round(attempts)) : 1;
}
