import type { StableDiffusionConfig } from '../../config/index.js';
import type { ImageResult } from '../llm/types.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger('stable-diffusion');

export interface ImageGenerator {
  readonly enabled: boolean;
  generate(prompt: string, options?: ImageGenerationOptions): Promise<ImageResult>;
}

export type ImageProfile = 'manga' | 'anime' | 'realistic' | 'nsfw';

export interface ImageGenerationOptions {
  profile?: ImageProfile;
  /** An in-memory pose reference passed to Forge's OpenPose preprocessor. */
  poseReference?: Buffer;
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

const NSFW_RE =
  /\b(nsfw|nude|nudity|naked|explicit|sex|sexual|porn|pussy|tits|boobs|cum|orgasm|lingerie|sesso|sessuale|porno|pornograf|nudo|nuda|cazzo|pompino|bocchino|figa|fica|vagina|pene|sborra|sperma|orgasmo|masturb|seghe|scopare|scopata|incul|culo|tette|tettona)\b/i;
const MINOR_RE =
  /\b(child|children|minor|underage|under-aged|loli|shota|toddler|infant|preteen)\b/i;
const ANIME_RE = /\b(anime|manga|waifu|otaku|gacha|vtuber|illustration|illustrated|cartoon)\b/i;

/**
 * Automatic1111 / Forge adapter. It serializes requests because model selection through
 * /options is global to the WebUI process; without the queue two users could get each other's model.
 */
export class StableDiffusionGenerator implements ImageGenerator {
  private activeModel: string | undefined;
  private models: SdModel[] | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly config: StableDiffusionConfig) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  generate(prompt: string, options: ImageGenerationOptions = {}): Promise<ImageResult> {
    const task = this.queue.then(() => this.generateSerial(prompt, options));
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
    if (MINOR_RE.test(userPrompt)) throw new Error('image prompt contains a minor-related term');

    const profile = options.profile ?? selectImageProfile(userPrompt);
    const model = await this.resolveModel(profile);
    const workflow = workflowFor(profile, this.config, userPrompt);
    const poseImage = options.poseReference?.toString('base64');
    const usesOpenPose = Boolean(poseImage && this.config.controlNet.enabled);
    const effectiveWorkflow = usesOpenPose ? controlNetWorkflow(userPrompt) : workflow;
    await this.waitForForgeIdle('before checkpoint selection');
    await this.applyModel(model);
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
    const res = await this.post(usesOpenPose ? '/sdapi/v1/img2img' : '/sdapi/v1/txt2img', {
      prompt: buildPrompt(userPrompt, profile),
      negative_prompt: negativePrompt(this.config.negativePrompt, profile, userPrompt),
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
    });
    const json = (await res.json()) as { images?: string[] };
    const base64 = json.images?.[0];
    if (!base64) throw new Error('Stable Diffusion returned no images');
    return {
      buffer: Buffer.from(base64.replace(/^data:image\/\w+;base64,/, ''), 'base64'),
      model,
    };
  }

  private async resolveModel(profile: ImageProfile): Promise<string> {
    const configured =
      profile === 'anime' || profile === 'manga'
        ? this.config.animeModel
        : profile === 'nsfw'
          ? this.config.nsfwModel
          : this.config.realisticModel;
    const models = await this.listModels();
    const match = models.find((model) => modelMatches(model, configured));
    if (!match)
      throw new Error(`Stable Diffusion ${profile} model is not installed: ${configured}`);
    return match.title;
  }

  private async listModels(): Promise<SdModel[]> {
    if (this.models) return this.models;
    const res = await this.request('/sdapi/v1/sd-models');
    const json = (await res.json()) as SdModel[];
    this.models = Array.isArray(json) ? json : [];
    return this.models;
  }

  private async applyModel(model: string): Promise<void> {
    if (this.activeModel === model) return;
    if (this.activeModel === undefined) {
      const res = await this.request('/sdapi/v1/options');
      const options = (await res.json()) as SdOptions;
      if (
        options.sd_model_checkpoint &&
        modelMatches({ title: options.sd_model_checkpoint }, model)
      ) {
        this.activeModel = model;
        log.info({ model }, 'requested checkpoint is already active in Forge');
        return;
      }
    }
    await this.post('/sdapi/v1/options', { sd_model_checkpoint: model });
    this.activeModel = model;
  }

  /** Wait for work started outside the bot too: Forge only has one global generation queue. */
  private async waitForForgeIdle(reason: string): Promise<void> {
    const deadline = Date.now() + this.config.queueTimeoutMs;
    let loggedBusy = false;
    while (true) {
      const res = await this.request(
        '/sdapi/v1/progress',
        {},
        Math.min(10_000, this.config.timeoutMs),
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
      await sleep(this.config.queuePollMs);
    }
  }

  private post(path: string, body: Record<string, unknown>): Promise<Response> {
    return this.request(path, { method: 'POST', body: JSON.stringify(body) });
  }

  private async request(
    path: string,
    init: RequestInit = {},
    timeoutMs = this.config.timeoutMs,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.config.apiUrl}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...init.headers },
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Stable Diffusion ${path} failed (${res.status}): ${text.slice(0, 500)}`);
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function selectImageProfile(prompt: string): ImageProfile {
  // Tags such as `rating_explicit` use underscores, which are word characters in JS regexes.
  // Normalize them before matching so an NSFW prompt can never fall through to the anime profile.
  const normalized = prompt.replace(/[_-]/g, ' ');
  if (NSFW_RE.test(normalized)) return 'nsfw';
  return ANIME_RE.test(normalized) ? 'anime' : 'realistic';
}

function buildPrompt(userPrompt: string, profile: ImageProfile): string {
  const subject = sanitizePrompt(userPrompt);
  const composition = compositionControls(subject);
  if (profile === 'nsfw') {
    return [
      'score_9, score_8_up, score_7_up, score_6_up, source_anime, rating_explicit',
      'adult, consenting adults only, detailed anatomy, coherent pose, expressive face',
      composition,
      subject,
      'highly detailed anime illustration, clean composition, no text, no watermark',
    ].join(', ');
  }
  if (profile === 'manga') {
    const subjectControls = mangaSubjectControls(subject);
    return [
      'score_9, score_8_up, score_7_up, score_6_up, source_anime, rating_safe',
      'full-color high-end manga key visual, precise ink lineart, controlled screentone accents, polished cel shading',
      'dynamic cinematic composition, visible expressive faces, precise anatomy, detailed background',
      subjectControls,
      composition,
      subject,
      'adult character when a person is depicted, no text, no logo, no watermark',
    ].join(', ');
  }
  if (profile === 'anime') {
    return [
      'score_9, score_8_up, score_7_up, score_6_up, source_anime, rating_safe',
      'detailed anime illustration, coherent anatomy, cinematic composition',
      composition,
      subject,
      'adult character when a person is depicted, no text, no watermark',
    ].join(', ');
  }
  return [
    'score_9, score_8_up, score_7_up, score_6_up, source_anime, rating_safe',
    'photo (medium), photorealistic, highly detailed, natural skin texture',
    composition,
    subject,
    'professional editorial photography, cinematic lighting, coherent anatomy, sharp focus, no text, no watermark',
  ].join(', ');
}

function compositionControls(prompt: string): string {
  const normalized = prompt.toLowerCase().replace(/[_-]/g, ' ');
  const twoSubjects =
    /\b(1girl\s*,\s*1boy|1boy\s*,\s*1girl|2girls|2boys|2people|two (?:people|subjects|characters|adults)|due (?:persone|soggetti)|soggetto\s*1.*soggetto\s*2|couple)\b/.test(
      normalized,
    );
  if (!twoSubjects) return 'solo, detailed face, sharp eyes, portrait composition';
  const shoulders = /\b(piggyback|riding on shoulders|on shoulders|sulle spalle|in spalla)\b/.test(
    normalized,
  );
  return [
    '(two people:1.45)',
    '(both subjects visible:1.35)',
    'full body',
    'wide shot',
    'both faces visible',
    'clear separate bodies',
    'detailed faces',
    shoulders
      ? '(piggyback pose:1.5), (carrying person on shoulders:1.4), standing'
      : 'clear interaction',
  ].join(', ');
}

function mangaSubjectControls(prompt: string): string {
  const hasGirl = /\b1girl\b/i.test(prompt);
  const hasBoy = /\b1boy\b/i.test(prompt);
  if (hasGirl && hasBoy) {
    return '(1girl:1.4), (1boy:1.35), (two separate characters:1.35), both characters visible';
  }
  if (hasGirl) return '(1girl:1.3), visible face, visible hands';
  if (hasBoy) return '(1boy:1.3), visible face, visible hands';
  return '';
}

function negativePrompt(base: string, profile: ImageProfile, userPrompt: string): string {
  const anatomy =
    'bad anatomy, bad hands, extra fingers, missing fingers, deformed, duplicate, cropped';
  const shoulderPose =
    /\b(piggyback|carrying person on shoulders|on shoulders|sulle spalle|in spalla)\b/i.test(
      userPrompt,
    );
  const actionNegative = shoulderPose ? ', motorcycle, motor vehicle, bicycle, car, scooter' : '';
  if (profile === 'nsfw') {
    return `${base}, ${anatomy}, extra arms, extra legs, fused bodies, malformed limbs, bad face, poorly drawn face, cross-eyed, underage, child, loli, shota, censored, mosaic censorship, text, watermark, signature, score_4, score_3, score_2, score_1${actionNegative}`;
  }
  if (profile === 'manga') {
    return `${base}, ${anatomy}, extra arms, extra legs, fused bodies, malformed limbs, bad face, poorly drawn face, cross-eyed, photorealistic, 3d render, color photo, blurry lineart, messy composition, silhouette, faceless, blacked-out face, text, watermark, logo, source_furry, source_pony, source_cartoon, rating_explicit, score_4, score_3, score_2, score_1${actionNegative}`;
  }
  if (profile === 'anime') {
    return `${base}, ${anatomy}, extra arms, extra legs, fused bodies, malformed limbs, bad face, poorly drawn face, cross-eyed, photorealistic, 3d render, source_furry, source_pony, source_cartoon, rating_explicit, score_4, score_3, score_2, score_1${actionNegative}`;
  }
  return `${base}, ${anatomy}, extra arms, extra legs, fused bodies, malformed limbs, bad face, poorly drawn face, cross-eyed, traditional media, painting, sketch, cartoon, illustration, 3d render, source_furry, source_pony, source_cartoon, rating_explicit, score_4, score_3, score_2, score_1${actionNegative}`;
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
  return /\b(1girl\s*,\s*1boy|1boy\s*,\s*1girl|2girls|2boys|2people|two (?:people|subjects|characters|adults)|due (?:persone|soggetti)|soggetto\s*1.*soggetto\s*2|couple)\b/i.test(
    prompt,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A valid 1x1 white PPM; Forge/Pillow expands it to the requested img2img dimensions. */
function blankCanvasPpm(): Buffer {
  return Buffer.concat([Buffer.from('P6\n1 1\n255\n', 'ascii'), Buffer.from([255, 255, 255])]);
}

function sanitizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim().slice(0, 1_000);
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
