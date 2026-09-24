import { randomBytes, randomUUID } from 'node:crypto';
import type { ComfyUiConfig } from '../../config/index.js';
import type { ImageResult } from '../llm/types.js';
import { childLogger } from '../../utils/logger.js';
import { assertMediaGenerationSafe } from '../../safety/mediaSafety.js';
import { abortableDelay, throwIfAborted } from '../../utils/abort.js';
import type { ImageGenerationOptions, ImageGenerator } from './stableDiffusion.js';

const log = childLogger('comfyui');
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const POLL_INTERVAL_MS = 1_500;

interface ComfyPromptResponse {
  prompt_id: string;
  number?: number;
  node_errors?: Record<string, unknown>;
  error?: unknown;
}

interface ComfyImageOutput {
  filename: string;
  subfolder?: string;
  type?: string;
}

interface ComfyHistoryItem {
  prompt?: unknown[];
  outputs?: Record<string, { images?: ComfyImageOutput[] }>;
  status?: {
    status_str?: string;
    completed?: boolean;
    messages?: Array<[string, unknown]>;
  };
}

export class ComfyUiGenerator implements ImageGenerator {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly config: ComfyUiConfig) {}

  get enabled(): boolean {
    return this.config.enabled && Boolean(this.config.apiUrl);
  }

  async generate(prompt: string, options: ImageGenerationOptions = {}): Promise<ImageResult> {
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
    if (!this.enabled) throw new Error('ComfyUI is disabled');
    assertMediaGenerationSafe(userPrompt);
    throwIfAborted(options.signal);

    const clientId = `goonerbot-${randomUUID().slice(0, 8)}`;
    const rawPrompt =
      options.providerPrompts?.qwen ?? options.providerPrompts?.agnes ?? userPrompt;
    const effectivePrompt = enforceQwenAdultSubject(rawPrompt);
    assertMediaGenerationSafe(effectivePrompt);

    const sanitizedNegative = sanitizeQwenNegative(options.negativePrompt ?? '');
    const dimensions = resolveDimensions(options.aspectRatio);
    const seed = randomSeed();
    const workflow = this.buildWorkflow(effectivePrompt, sanitizedNegative, dimensions, seed);

    log.info(
      {
        size: `${dimensions.width}x${dimensions.height}`,
        steps: this.config.steps,
        seed,
        sampler: this.config.sampler,
      },
      'queueing Qwen-Image-2.1 generation on ComfyUI',
    );

    const promptRes = await this.postJson<ComfyPromptResponse>(
      '/prompt',
      { client_id: clientId, prompt: workflow },
      options.signal,
    );

    if (promptRes.node_errors && Object.keys(promptRes.node_errors).length > 0) {
      log.error({ errors: promptRes.node_errors }, 'ComfyUI node validation failed');
      throw new Error(`ComfyUI workflow error: ${JSON.stringify(promptRes.node_errors)}`);
    }

    const promptId = promptRes.prompt_id;
    if (!promptId) {
      throw new Error(`ComfyUI did not return a prompt_id: ${JSON.stringify(promptRes)}`);
    }

    log.info({ promptId }, 'ComfyUI prompt queued; waiting for execution to complete');
    await options.onProgress?.(15, 'in coda su GPU...');

    const imageInfo = await this.waitForCompletion(promptId, options.signal, options.onProgress, clientId);
    log.info({ promptId, imageInfo }, 'ComfyUI generation completed; downloading artifact');

    const buffer = await this.downloadImage(imageInfo, options.signal);
    await options.onProgress?.(100, 'immagine pronta');
    return {
      buffer,
      model: this.config.diffusionModel,
      provider: 'pony',
      mime: 'image/png',
    };
  }

  private buildWorkflow(
    prompt: string,
    negativePrompt: string,
    dimensions: { width: number; height: number },
    seed: number,
  ): Record<string, unknown> {
    return {
      '1': {
        class_type: 'UNETLoader',
        inputs: {
          unet_name: this.config.diffusionModel,
          weight_dtype: 'default',
        },
      },
      '2': {
        class_type: 'CLIPLoader',
        inputs: {
          clip_name: this.config.textEncoder,
          type: 'qwen_image',
        },
      },
      '3': {
        class_type: 'VAELoader',
        inputs: {
          vae_name: this.config.vae,
        },
      },
      '4': {
        class_type: 'TextEncodeQwenImage21',
        inputs: {
          clip: ['2', 0],
          prompt,
          negative_prompt: negativePrompt,
          resolution: 1024,
        },
      },
      '5': {
        class_type: 'EmptyLatentImage',
        inputs: {
          width: dimensions.width,
          height: dimensions.height,
          batch_size: 1,
        },
      },
      '6': {
        class_type: 'KSampler',
        inputs: {
          model: ['1', 0],
          positive: ['4', 0],
          negative: ['4', 1],
          latent_image: ['5', 0],
          seed,
          steps: this.config.steps,
          cfg: this.config.cfgScale,
          sampler_name: this.config.sampler,
          scheduler: this.config.scheduler,
          denoise: 1.0,
        },
      },
      '7': {
        class_type: 'VAEDecode',
        inputs: {
          samples: ['6', 0],
          vae: ['3', 0],
        },
      },
      '8': {
        class_type: 'SaveImage',
        inputs: {
          images: ['7', 0],
          filename_prefix: 'Qwen_image_2.1',
        },
      },
    };
  }

  private async waitForCompletion(
    promptId: string,
    signal?: AbortSignal,
    onProgress?: (percent: number, stage?: string) => void | Promise<void>,
    clientId?: string,
  ): Promise<ComfyImageOutput> {
    const deadline = Date.now() + this.config.timeoutMs;
    const startTime = Date.now();
    let ws: { close: () => void } | null = null;

    if (clientId && typeof globalThis.WebSocket !== 'undefined') {
      try {
        const wsUrl = this.config.apiUrl.replace(/^http/i, 'ws') + `/ws?clientId=${clientId}`;
        const socket = new globalThis.WebSocket(wsUrl);
        ws = socket;
        socket.onmessage = (event: { data: unknown }) => {
          try {
            const raw = typeof event.data === 'string' ? event.data : String(event.data ?? '');
            if (!raw) return;
            const msg = JSON.parse(raw) as {
              type?: string;
              data?: { value?: number; max?: number; node?: unknown; prompt_id?: string };
            };
            if (msg.type === 'progress' && msg.data?.prompt_id === promptId) {
              const { value, max } = msg.data;
              if (typeof value === 'number' && typeof max === 'number' && max > 0) {
                const stepPercent = Math.min(90, Math.round(15 + (value / max) * 75));
                void onProgress?.(stepPercent, `rendering step ${value}/${max}`);
              }
            } else if (msg.type === 'executing' && msg.data?.prompt_id === promptId) {
              if (msg.data.node === null) {
                void onProgress?.(92, 'elaborazione completata');
              }
            }
          } catch {
            // ignore ws parse error
          }
        };
      } catch (err) {
        log.debug({ err }, 'failed to open ComfyUI websocket; falling back to polling');
      }
    }

    try {
      while (Date.now() < deadline) {
        throwIfAborted(signal);

        const elapsed = (Date.now() - startTime) / 1000;
        const estimated = Math.min(85, Math.round(15 + Math.min(elapsed / 16, 1) * 70));
        void onProgress?.(estimated, 'elaborazione su GPU...');

        const res = await this.fetchSafe(`/history/${promptId}`, { signal });
        if (res.ok) {
          const history = (await res.json()) as Record<string, ComfyHistoryItem>;
          const item = history[promptId];
          if (item) {
            if (item.status?.status_str === 'error') {
              const errorMsg = item.status.messages
                ?.map((m) => JSON.stringify(m[1]))
                .join(' ') || 'unknown error';
              throw new Error(`ComfyUI execution failed: ${errorMsg}`);
            }

            if (item.status?.completed) {
              const image = this.findImageInOutputs(item.outputs);
              if (image) {
                void onProgress?.(92, 'scaricamento immagine...');
                return image;
              }
              throw new Error('ComfyUI finished execution but output contained no images');
            }
          }
        }

        await abortableDelay(POLL_INTERVAL_MS, signal);
      }

      throw new Error(`ComfyUI generation timed out after ${Math.round(this.config.timeoutMs / 1000)}s`);
    } finally {
      if (ws) {
        try {
          ws.close();
        } catch {
          // ignore ws close error
        }
      }
    }
  }

  private findImageInOutputs(
    outputs?: Record<string, { images?: ComfyImageOutput[] }>,
  ): ComfyImageOutput | null {
    if (!outputs) return null;
    const saveNode = outputs['8']?.images?.[0];
    if (saveNode) return saveNode;

    for (const node of Object.values(outputs)) {
      if (node.images?.[0]) return node.images[0];
    }
    return null;
  }

  private async downloadImage(
    image: ComfyImageOutput,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const params = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder ?? '',
      type: image.type ?? 'output',
    });

    const res = await this.fetchSafe(`/view?${params.toString()}`, { signal });
    if (!res.ok) {
      throw new Error(`Failed to download ComfyUI image (${res.status} ${res.statusText})`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (!buffer.length) {
      throw new Error('ComfyUI returned an empty image buffer');
    }
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new Error(`ComfyUI image exceeded maximum allowed bytes (${buffer.length})`);
    }
    return buffer;
  }

  private async postJson<T>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await this.fetchSafe(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ComfyUI request to ${path} failed (${res.status}): ${text}`);
    }

    return (await res.json()) as T;
  }

  private fetchSafe(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.config.apiUrl}${path}`;
    return fetch(url, init);
  }
}

function resolveDimensions(
  aspectRatio?: ImageGenerationOptions['aspectRatio'],
): { width: number; height: number } {
  switch (aspectRatio) {
    case '16:9':
      return { width: 1344, height: 768 };
    case '9:16':
      return { width: 768, height: 1344 };
    case '1:1':
    default:
      return { width: 1024, height: 1024 };
  }
}

function randomSeed(): number {
  return randomBytes(4).readUInt32BE(0);
}

/**
 * Qwen-Image-2.1 uses a text encoder (Qwen2.5-VL / Qwen LM) where mentioning minor-related
 * words in negative prompts causes cross-attention token leakage.
 * Strip minor-related terms from the negative prompt to prevent activating youth token associations.
 */
function sanitizeQwenNegative(negativePrompt: string): string {
  return negativePrompt
    .split(',')
    .map((s) => s.trim())
    .filter(
      (s) =>
        s.length > 0 &&
        !/\b(child|children|kid|kids|underage|loli|lolita|shota|teen|minor|baby|infant|schoolgirl|schoolboy)\b/i.test(
          s,
        ),
    )
    .join(', ');
}

/**
 * If human subjects are requested, explicitly anchor adult maturity in the prompt for Qwen.
 */
function enforceQwenAdultSubject(prompt: string): string {
  if (
    /\b(person|people|woman|women|man|men|girl|guy|waifu|character|female|male)\b/i.test(prompt) &&
    !/\b(adult|mature|elderly|middle-aged)\b/i.test(prompt)
  ) {
    return `mature adult, ${prompt}`;
  }
  return prompt;
}
