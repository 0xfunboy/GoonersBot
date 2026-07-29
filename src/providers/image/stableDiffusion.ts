import type { StableDiffusionConfig } from '../../config/index.js';
import type { ImageResult } from '../llm/types.js';
import { childLogger } from '../../utils/logger.js';
import {
  assertMediaGenerationSafe,
  containsExplicitMediaReference,
  containsSuggestiveMediaReference,
} from '../../safety/mediaSafety.js';
import { abortableDelay, createAbortScope, throwIfAborted } from '../../utils/abort.js';
import type {
  ImageContentRating,
  ImageMedium,
  ProviderImagePrompts,
} from '../../services/imagePrompt.js';

const log = childLogger('stable-diffusion');
const MAX_FORGE_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface ImageGenerator {
  readonly enabled: boolean;
  generate(prompt: string, options?: ImageGenerationOptions): Promise<ImageResult>;
}

export type ImageProfile = 'manga' | 'anime' | 'realistic' | 'nsfw';

export interface ImageGenerationOptions {
  profile?: ImageProfile;
  medium?: ImageMedium;
  rating?: ImageContentRating;
  /** Prompts compiled from one shared scene contract for the individual backends. */
  providerPrompts?: ProviderImagePrompts;
  /** Natural visual contract used by the vision QA pass. */
  qualityBrief?: string;
  /** True when an adult-rated scene contains people whose visible adulthood must be verified. */
  expectsPeople?: boolean;
  /** Preferred first backend; the fallback router may still use the other one. */
  preferredProvider?: 'agnes' | 'pony';
  /** Focused correction from a failed generated-image QA pass. */
  retryFeedback?: string;
  /** Per-scene defects supplied by the visual planner, appended to the checkpoint baseline. */
  negativePrompt?: string;
  /** An in-memory pose reference passed to Forge's OpenPose preprocessor. */
  poseReference?: Buffer;
  /** Cooperative cancellation from the host action. */
  signal?: AbortSignal;
  aspectRatio?: '16:9' | '9:16' | '1:1';
}

interface SdModel {
  title: string;
  model_name?: string;
  filename?: string;
}

interface SdProgress {
  progress?: number;
  state?: { job?: string; job_count?: number };
}

interface SdOptions {
  sd_model_checkpoint?: string;
}

const ANIME_RE = /\b(anime|manga|waifu|otaku|gacha|vtuber|illustration|illustrated|cartoon)\b/i;

/**
 * Automatic1111 / Forge adapter. It serializes requests because model selection through
 * /options is global to the WebUI process; without the queue two users could get each other's model.
 */
export class StableDiffusionGenerator implements ImageGenerator {
  private models: SdModel[] | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly config: StableDiffusionConfig) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  generate(prompt: string, options: ImageGenerationOptions = {}): Promise<ImageResult> {
    assertMediaGenerationSafe(prompt);
    const task = this.queue.then(() => {
      throwIfAborted(options.signal);
      return this.generateSerial(prompt, options);
    });
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async generateSerial(
    userPrompt: string,
    options: ImageGenerationOptions,
  ): Promise<ImageResult> {
    if (!this.enabled) throw new Error('Stable Diffusion is disabled');
    assertMediaGenerationSafe(userPrompt);
    throwIfAborted(options.signal);

    const profile = options.profile ?? selectImageProfile(userPrompt);
    const medium = options.medium ?? mediumFromProfile(profile);
    const rating = options.rating ?? ratingFromProfile(profile);
    const providerPrompt = options.providerPrompts?.pony ?? userPrompt;
    assertMediaGenerationSafe(providerPrompt);
    const model = await this.resolveModel(profile, medium, rating, options.signal);
    const workflow = workflowFor(profile, this.config, providerPrompt);
    const poseImage = options.poseReference?.toString('base64');
    const usesOpenPose = Boolean(poseImage && this.config.controlNet.enabled);
    const effectiveWorkflow = applyAspectRatio(
      usesOpenPose ? controlNetWorkflow(userPrompt) : workflow,
      options.aspectRatio,
      usesOpenPose,
    );
    await this.waitForForgeIdle('before checkpoint selection', options.signal);
    await this.applyModel(model, options.signal);
    log.info(
      {
        profile,
        model,
        sampler: effectiveWorkflow.sampler,
        size: `${effectiveWorkflow.width}x${effectiveWorkflow.height}`,
        controlNet: usesOpenPose,
      },
      'generating image with selected checkpoint',
    );
    const res = await this.post(
      usesOpenPose ? '/sdapi/v1/img2img' : '/sdapi/v1/txt2img',
      {
        prompt: buildPrompt(providerPrompt, medium, rating, options.retryFeedback),
        negative_prompt: mergeNegativePrompts(
          filterConfiguredNegative(this.config.negativePrompt, providerPrompt),
          negativePrompt(medium, rating, providerPrompt),
          options.negativePrompt,
        ),
        sampler_name: effectiveWorkflow.sampler,
        steps: effectiveWorkflow.steps,
        width: effectiveWorkflow.width,
        height: effectiveWorkflow.height,
        cfg_scale: effectiveWorkflow.cfgScale,
        override_settings: { CLIP_stop_at_last_layers: 2 },
        batch_size: 1,
        n_iter: 1,
        do_not_save_samples: true,
        do_not_save_grid: true,
        // Forge Neo's ControlNet txt2img path currently accesses a missing resize_mode property.
        // An in-memory blank img2img base initializes that property while denoise=1 keeps this text-to-image.
        ...(usesOpenPose
          ? {
              init_images: [blankCanvasPpm().toString('base64')],
              denoising_strength: 1,
              resize_mode: 1,
              alwayson_scripts: {
                controlnet: {
                  args: [
                    {
                      enabled: true,
                      input_image: poseImage,
                      module: 'openpose_full',
                      model: this.config.controlNet.openPoseModel,
                      weight: this.config.controlNet.weight,
                      resize_mode: 'Crop and Resize',
                      processor_res: this.config.controlNet.processorResolution,
                      guidance_start: 0,
                      guidance_end: 1,
                      pixel_perfect: true,
                      control_mode: 'Balanced',
                    },
                  ],
                },
              },
            }
          : {}),
      },
      options.signal,
    );
    const json = (await res.json()) as { images?: string[] };
    const base64 = json.images?.[0];
    if (!base64) throw new Error('Stable Diffusion returned no images');
    return {
      buffer: Buffer.from(base64.replace(/^data:image\/\w+;base64,/, ''), 'base64'),
      model,
      provider: 'pony',
      mime: 'image/png',
    };
  }

  private async resolveModel(
    profile: ImageProfile,
    medium: ImageMedium,
    rating: ImageContentRating,
    signal?: AbortSignal,
  ): Promise<string> {
    const configured =
      rating === 'explicit' || profile === 'nsfw'
        ? this.config.nsfwModel
        : medium === 'anime' || medium === 'manga' || medium === 'comic'
          ? this.config.animeModel
          : this.config.realisticModel;
    const models = await this.listModels(signal);
    const match = models.find((model) => modelMatches(model, configured));
    if (!match)
      throw new Error(`Stable Diffusion ${profile} model is not installed: ${configured}`);
    return match.title;
  }

  private async listModels(signal?: AbortSignal): Promise<SdModel[]> {
    if (this.models) return this.models;
    const res = await this.request('/sdapi/v1/sd-models', {}, this.config.timeoutMs, signal);
    const json = (await res.json()) as SdModel[];
    this.models = Array.isArray(json) ? json : [];
    return this.models;
  }

  private async applyModel(model: string, signal?: AbortSignal): Promise<void> {
    // Forge is shared with its frontend and other clients. Never trust our local cache without
    // checking the process-wide option: an external checkpoint switch must not silently make this
    // request run on, and be reported as, the wrong model.
    const res = await this.request('/sdapi/v1/options', {}, this.config.timeoutMs, signal);
    const options = (await res.json()) as SdOptions;
    if (
      options.sd_model_checkpoint &&
      modelMatches({ title: options.sd_model_checkpoint }, model)
    ) {
      log.info({ model }, 'requested checkpoint is already active in Forge');
      return;
    }
    await this.post('/sdapi/v1/options', { sd_model_checkpoint: model }, signal);
  }

  /** Wait for work started outside the bot too: Forge only has one global generation queue. */
  private async waitForForgeIdle(reason: string, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.config.queueTimeoutMs;
    let loggedBusy = false;
    for (;;) {
      const res = await this.request(
        '/sdapi/v1/progress',
        {},
        Math.min(10_000, this.config.timeoutMs),
        signal,
      );
      const progress = (await res.json()) as SdProgress;
      const busy =
        (progress.progress ?? 0) > 0 ||
        Boolean(progress.state?.job) ||
        (progress.state?.job_count ?? 0) > 0;
      if (!busy) return;
      if (!loggedBusy) {
        loggedBusy = true;
        log.info({ reason }, 'Forge is busy; waiting for its current generation to finish');
      }
      if (Date.now() >= deadline) {
        throw new Error(`Stable Diffusion remained busy for ${this.config.queueTimeoutMs}ms`);
      }
      await abortableDelay(this.config.queuePollMs, signal);
    }
  }

  private post(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.request(
      path,
      { method: 'POST', body: JSON.stringify(body) },
      this.config.timeoutMs,
      signal,
    );
  }

  private async request(
    path: string,
    init: RequestInit = {},
    timeoutMs = this.config.timeoutMs,
    signal?: AbortSignal,
  ): Promise<Response> {
    const scope = createAbortScope(timeoutMs, signal, `Stable Diffusion ${path}`);
    try {
      const res = await fetch(`${this.config.apiUrl}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...init.headers },
        signal: scope.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Stable Diffusion ${path} failed (${res.status}): ${text.slice(0, 500)}`);
      }
      const body = await readBoundedBody(res, MAX_FORGE_RESPONSE_BYTES);
      // Return an in-memory response so callers can parse JSON after the timeout scope is disposed
      // without leaving the Forge body stream or global generation queue unbounded.
      return new Response(body.length ? body : null, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    } finally {
      scope.dispose();
    }
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel('Forge response exceeded byte limit').catch(() => undefined);
      throw new Error(`Stable Diffusion response exceeded ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
}

export function selectImageProfile(prompt: string): ImageProfile {
  const normalized = prompt.replace(/[_-]/g, ' ');
  if (containsExplicitMediaReference(normalized) || containsSuggestiveMediaReference(normalized)) {
    return 'nsfw';
  }
  return ANIME_RE.test(normalized) ? 'anime' : 'realistic';
}

function buildPrompt(
  userPrompt: string,
  medium: ImageMedium,
  rating: ImageContentRating,
  retryFeedback?: string,
): string {
  const subject = sanitizePrompt(userPrompt);
  return uniquePromptParts(
    'score_9',
    'score_8_up',
    'score_7_up',
    'score_6_up',
    'score_5_up',
    'score_4_up',
    sourceTag(medium),
    ratingTag(rating),
    mediumPositive(medium),
    rating === 'explicit' ? 'unambiguously adult, consenting adults only' : '',
    subject,
    retryFeedback ? `correction, ${sanitizePrompt(retryFeedback)}` : '',
    'coherent anatomy',
    'intentional composition',
    'high detail',
  )
    .join(', ')
    .slice(0, 2_500);
}

function negativePrompt(
  medium: ImageMedium,
  rating: ImageContentRating,
  userPrompt: string,
): string {
  const shoulderPose =
    /\b(piggyback|carrying person on shoulders|on shoulders|sulle spalle|in spalla)\b/i.test(
      userPrompt,
    );
  const actionNegative = shoulderPose ? ', motorcycle, motor vehicle, bicycle, car, scooter' : '';
  return (
    uniquePromptParts(
      'score_3',
      'score_2',
      'score_1',
      'bad anatomy',
      'bad hands',
      'extra fingers',
      'missing fingers',
      'duplicate',
      'extra subjects',
      'fused bodies',
      'malformed limbs',
      'bad face',
      'cross-eyed',
      ...providerMediumNegatives(medium),
      ...(rating === 'explicit'
        ? ['underage', 'child', 'loli', 'shota', 'censored', 'mosaic censorship']
        : ['rating_explicit', 'nsfw', 'nudity']),
    ).join(', ') + actionNegative
  );
}

function mediumFromProfile(profile: ImageProfile): ImageMedium {
  if (profile === 'manga') return 'manga';
  if (profile === 'anime' || profile === 'nsfw') return 'anime';
  return 'photo';
}

function ratingFromProfile(profile: ImageProfile): ImageContentRating {
  return profile === 'nsfw' ? 'explicit' : 'safe';
}

function sourceTag(medium: ImageMedium): string {
  if (medium === 'anime' || medium === 'manga') return 'source_anime';
  if (medium === 'comic' || medium === 'pixel_art' || medium === 'digital_illustration') {
    return 'source_cartoon';
  }
  return '';
}

function ratingTag(rating: ImageContentRating): string {
  if (rating === 'explicit') return 'rating_explicit';
  if (rating === 'suggestive') return 'rating_questionable';
  return 'rating_safe';
}

function mediumPositive(medium: ImageMedium): string {
  switch (medium) {
    case 'photo':
      return 'photo (medium), photorealistic, professional editorial photography, natural skin texture';
    case 'anime':
      return 'polished anime illustration, clean lineart, controlled cel shading';
    case 'manga':
      return 'professional manga illustration, precise ink lineart, controlled screentone';
    case 'comic':
      return 'professional comic-book illustration, expressive ink linework';
    case 'watercolor':
      return 'traditional watercolor painting, visible watercolor pigment, textured paper';
    case 'oil_painting':
      return 'traditional oil painting, visible brushwork, layered pigments';
    case 'pixel_art':
      return 'crisp pixel art, deliberate pixel clusters, limited palette';
    case 'three_d':
      return 'high-end 3d render, physically based materials, cinematic render';
    case 'digital_illustration':
    default:
      return 'high-end digital illustration, polished rendering';
  }
}

function providerMediumNegatives(medium: ImageMedium): string[] {
  switch (medium) {
    case 'photo':
      return ['anime', 'manga', 'cartoon', 'illustration', '3d render', 'plastic skin'];
    case 'anime':
      return ['photorealistic', '3d render', 'muddy colors'];
    case 'manga':
      return ['photorealistic', '3d render', 'muddy lineart'];
    case 'comic':
      return ['photorealistic', '3d render', 'muddy lineart'];
    case 'watercolor':
      return ['photorealistic', '3d render', 'pixel art', 'vector art'];
    case 'oil_painting':
      return ['photorealistic', '3d render', 'pixel art', 'vector art'];
    case 'pixel_art':
      return ['photorealistic', 'smooth painting', '3d render', 'vector art'];
    case 'three_d':
      return ['flat illustration', 'sketch', 'watercolor'];
    case 'digital_illustration':
    default:
      return ['photorealistic', 'low-detail sketch'];
  }
}

function mergeNegativePrompts(...prompts: Array<string | undefined>): string {
  return uniquePromptParts(
    ...prompts.flatMap((prompt) => (prompt ?? '').split(',').map((part) => part.trim())),
  )
    .join(', ')
    .slice(0, 2_000);
}

function filterConfiguredNegative(negative: string, positive: string): string {
  const allowsText = /\b(exact text|text reading|caption reading|requested placement)\b/i.test(
    positive,
  );
  const allowsLogo = /\b(logo|logotype|brand mark|emblem)\b/i.test(positive);
  if (!allowsText && !allowsLogo) return negative;
  return negative
    .split(',')
    .map((part) => part.trim())
    .filter((part) => {
      if (allowsText && /^(?:text|caption|letters?|typography)$/i.test(part)) return false;
      if (allowsLogo && /^(?:logo|logotype|brand mark|emblem)$/i.test(part)) return false;
      return true;
    })
    .join(', ');
}

function uniquePromptParts(...parts: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of parts) {
    const value = raw?.replace(/\s+/g, ' ').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function workflowFor(
  profile: ImageProfile,
  config: StableDiffusionConfig,
  prompt: string,
): {
  sampler: string;
  steps: number;
  width: number;
  height: number;
  cfgScale: number;
} {
  if (profile === 'manga') {
    const scene = hasMultipleSubjects(prompt) || /\b(group|crowd)\b/i.test(prompt);
    return scene
      ? { sampler: 'Euler a', steps: 28, width: 1152, height: 832, cfgScale: 7 }
      : { sampler: 'Euler a', steps: 28, width: 1024, height: 1024, cfgScale: 7 };
  }
  if (profile === 'nsfw') {
    const scene = hasMultipleSubjects(prompt);
    return scene
      ? { sampler: 'Euler a', steps: 28, width: 1152, height: 832, cfgScale: 7 }
      : { sampler: 'Euler a', steps: 28, width: 1024, height: 1024, cfgScale: 7 };
  }
  if (profile === 'realistic') {
    const scene = hasMultipleSubjects(prompt);
    return scene
      ? { sampler: 'Euler a', steps: 28, width: 1152, height: 832, cfgScale: 7 }
      : { sampler: 'Euler a', steps: 28, width: 1024, height: 1024, cfgScale: 7 };
  }
  return {
    sampler: 'Euler a',
    steps: Math.max(config.steps, 28),
    width: 1024,
    height: 1024,
    cfgScale: 7,
  };
}

/** Keep OpenPose + PonyXL below the VRAM cliff on the shared 12 GB card. */
function controlNetWorkflow(prompt: string): {
  sampler: string;
  steps: number;
  width: number;
  height: number;
  cfgScale: number;
} {
  const vertical =
    /\b(back view|from behind|upside down|inverted|head down|standing|kneeling|sitting|lying|sdrai|sedut|inginocchi|in piedi|di spalle|testa in gi[uù])\b/i.test(
      prompt,
    );
  return vertical
    ? { sampler: 'Euler a', steps: 22, width: 640, height: 832, cfgScale: 6.5 }
    : { sampler: 'Euler a', steps: 22, width: 832, height: 640, cfgScale: 6.5 };
}

function hasMultipleSubjects(prompt: string): boolean {
  return /\b(1girl\s*,\s*1boy|1boy\s*,\s*1girl|1woman\s*,\s*1man|1man\s*,\s*1woman|2girls|2boys|2women|2men|2animals|2dogs|2cats|2people|2subjects|two (?:people|subjects|characters|adults|women|men|animals|dogs|cats)|due (?:persone|soggetti|donne|uomini|animali|cani|gatti)|soggetto\s*1.*soggetto\s*2|couple)\b/i.test(
    prompt,
  );
}

function applyAspectRatio<T extends { width: number; height: number }>(
  workflow: T,
  aspectRatio: ImageGenerationOptions['aspectRatio'],
  controlNet: boolean,
): T {
  if (!aspectRatio) return workflow;
  const long = controlNet ? 832 : 1152;
  const short = controlNet ? 512 : 640;
  const square = controlNet ? 768 : 1024;
  const dimensions =
    aspectRatio === '16:9'
      ? { width: long, height: short }
      : aspectRatio === '9:16'
        ? { width: short, height: long }
        : { width: square, height: square };
  return { ...workflow, ...dimensions };
}

/** A valid 1x1 white PPM; Forge/Pillow expands it to the requested img2img dimensions. */
function blankCanvasPpm(): Buffer {
  return Buffer.concat([Buffer.from('P6\n1 1\n255\n', 'ascii'), Buffer.from([255, 255, 255])]);
}

function sanitizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim().slice(0, 1_800);
}

function modelMatches(model: SdModel, configured: string): boolean {
  const wanted = normalizeModelName(configured);
  return [model.title, model.model_name, model.filename]
    .filter((value): value is string => Boolean(value))
    .some(
      (value) =>
        normalizeModelName(value).includes(wanted) || wanted.includes(normalizeModelName(value)),
    );
}

function normalizeModelName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}
