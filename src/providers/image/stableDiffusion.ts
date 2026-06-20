import type { StableDiffusionConfig } from '../../config/index.js';
import type { ImageResult } from '../llm/types.js';

export interface ImageGenerator {
  readonly enabled: boolean;
  generate(prompt: string): Promise<ImageResult>;
}

type ImageProfile = 'anime' | 'realistic' | 'nsfw';

interface SdModel {
  title: string;
  model_name?: string;
  filename?: string;
}

const NSFW_RE =
  /\b(nsfw|nude|nudity|naked|explicit|sex|sexual|porn|pussy|tits|boobs|cum|orgasm|lingerie)\b/i;
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

  generate(prompt: string): Promise<ImageResult> {
    const task = this.queue.then(() => this.generateSerial(prompt));
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async generateSerial(userPrompt: string): Promise<ImageResult> {
    if (!this.enabled) throw new Error('Stable Diffusion is disabled');
    if (MINOR_RE.test(userPrompt)) throw new Error('image prompt contains a minor-related term');

    const profile = selectProfile(userPrompt);
    const model = await this.resolveModel(profile);
    await this.applyModel(model);
    const res = await this.post('/sdapi/v1/txt2img', {
      prompt: buildPrompt(userPrompt, profile),
      negative_prompt: negativePrompt(this.config.negativePrompt, profile),
      steps: this.config.steps,
      width: this.config.width,
      height: this.config.height,
      cfg_scale: this.config.cfgScale,
      batch_size: 1,
      n_iter: 1,
      do_not_save_samples: true,
      do_not_save_grid: true,
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
      profile === 'anime'
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
    await this.post('/sdapi/v1/options', { sd_model_checkpoint: model });
    this.activeModel = model;
  }

  private post(path: string, body: Record<string, unknown>): Promise<Response> {
    return this.request(path, { method: 'POST', body: JSON.stringify(body) });
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
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

function selectProfile(prompt: string): ImageProfile {
  if (NSFW_RE.test(prompt)) return 'nsfw';
  return ANIME_RE.test(prompt) ? 'anime' : 'realistic';
}

function buildPrompt(userPrompt: string, profile: ImageProfile): string {
  const subject = sanitizePrompt(userPrompt);
  if (profile === 'nsfw') {
    return [
      'score_9, score_8_up, score_7_up, rating_explicit, source_anime',
      'adult woman, consenting adults only, highly detailed anime illustration',
      subject,
      'expressive composition, detailed anatomy, no text, no watermark',
    ].join(', ');
  }
  if (profile === 'anime') {
    return [
      'masterpiece, best quality, very aesthetic, newest',
      'detailed anime illustration, coherent anatomy, cinematic composition',
      subject,
      'adult character when a person is depicted, no text, no watermark',
    ].join(', ');
  }
  return [
    'masterpiece, best quality, photorealistic, highly detailed, natural skin texture',
    subject,
    'professional cinematic lighting, coherent anatomy, no text, no watermark',
  ].join(', ');
}

function negativePrompt(base: string, profile: ImageProfile): string {
  const anatomy =
    'bad anatomy, bad hands, extra fingers, missing fingers, deformed, duplicate, cropped';
  if (profile === 'nsfw') return `${base}, ${anatomy}, underage, child, loli, shota, censorship`;
  if (profile === 'anime') return `${base}, ${anatomy}, photorealistic, 3d render`;
  return `${base}, ${anatomy}, anime, cartoon, illustration`;
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
