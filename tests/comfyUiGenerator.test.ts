import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComfyUiGenerator } from '../src/providers/image/comfyUi.js';
import type { ComfyUiConfig } from '../src/config/index.js';

describe('ComfyUiGenerator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseConfig: ComfyUiConfig = {
    enabled: true,
    apiUrl: 'http://comfy.test:8188',
    diffusionModel: 'qwen_image_2.1_int8_convrot.safetensors',
    textEncoder: 'qwen3vl_8b_int8_convrot.safetensors',
    vae: 'qwen_image_2.1_vae_bf16.safetensors',
    steps: 25,
    cfgScale: 1.0,
    sampler: 'euler',
    scheduler: 'simple',
    timeoutMs: 5000,
  };

  it('generates an image and downloads the output from ComfyUI', async () => {
    const promptId = 'test-prompt-id-123';
    const fakeImageBuffer = Buffer.from('fake-png-data');

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/prompt')) {
        const body = JSON.parse(init?.body as string);
        expect(body.prompt).toBeDefined();
        // Verify key nodes in workflow
        expect(body.prompt['1'].inputs.unet_name).toBe('qwen_image_2.1_int8_convrot.safetensors');
        expect(body.prompt['2'].inputs.clip_name).toBe('qwen3vl_8b_int8_convrot.safetensors');
        expect(body.prompt['3'].inputs.vae_name).toBe('qwen_image_2.1_vae_bf16.safetensors');
        expect(body.prompt['4'].inputs.prompt).toBe('a serene mountain landscape');
        expect(body.prompt['6'].inputs.steps).toBe(25);
        expect(body.prompt['6'].inputs.cfg).toBe(1.0);
        return new Response(JSON.stringify({ prompt_id: promptId }), { status: 200 });
      }

      if (urlStr.endsWith(`/history/${promptId}`)) {
        return new Response(
          JSON.stringify({
            [promptId]: {
              status: {
                completed: true,
                status_str: 'success',
              },
              outputs: {
                '8': {
                  images: [
                    {
                      filename: 'Qwen_image_2.1_0001.png',
                      subfolder: '',
                      type: 'output',
                    },
                  ],
                },
              },
            },
          }),
          { status: 200 },
        );
      }

      if (urlStr.includes('/view?')) {
        expect(urlStr).toContain('filename=Qwen_image_2.1_0001.png');
        expect(urlStr).toContain('subfolder=');
        expect(urlStr).toContain('type=output');
        return new Response(fakeImageBuffer, {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }

      return new Response('Not found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const generator = new ComfyUiGenerator(baseConfig);
    expect(generator.enabled).toBe(true);

    const result = await generator.generate('a serene mountain landscape');

    expect(result.mime).toBe('image/png');
    expect(result.buffer?.equals(fakeImageBuffer)).toBe(true);
  });

  it('rejects prompts with blocked child safety content', async () => {
    const generator = new ComfyUiGenerator(baseConfig);
    await expect(generator.generate('nsfw loli uncensored')).rejects.toThrow(
      /media generation involving or implying a minor is not allowed/,
    );
  });

  it('throws when ComfyUI returns node errors', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/prompt')) {
        return new Response(
          JSON.stringify({
            node_errors: {
              '1': ['Model not found: qwen_image_2.1_int8_convrot.safetensors'],
            },
          }),
          { status: 200 },
        );
      }
      return new Response('Not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const generator = new ComfyUiGenerator(baseConfig);
    await expect(generator.generate('test')).rejects.toThrow(/ComfyUI workflow error/);
  });

  it('throws when execution fails in status history', async () => {
    const promptId = 'failed-prompt-id';
    const fetchMock = vi.fn(async (url: string) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/prompt')) {
        return new Response(JSON.stringify({ prompt_id: promptId }), { status: 200 });
      }
      if (urlStr.endsWith(`/history/${promptId}`)) {
        return new Response(
          JSON.stringify({
            [promptId]: {
              status: {
                completed: true,
                status_str: 'error',
                messages: [['execution_error', 'CUDA out of memory']],
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response('Not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const generator = new ComfyUiGenerator(baseConfig);
    await expect(generator.generate('test')).rejects.toThrow(/ComfyUI execution failed/);
  });

  it('serializes concurrent generation requests', async () => {
    const executionOrder: string[] = [];

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/prompt')) {
        const body = JSON.parse(init?.body as string);
        const promptText = body.prompt['4'].inputs.prompt;
        executionOrder.push(`start-${promptText}`);
        return new Response(JSON.stringify({ prompt_id: `id-${promptText}` }), { status: 200 });
      }
      if (urlStr.includes('/history/')) {
        const match = urlStr.match(/\/history\/id-(.*)$/);
        const name = match?.[1] ?? '';
        executionOrder.push(`end-${name}`);
        return new Response(
          JSON.stringify({
            [`id-${name}`]: {
              status: { completed: true, status_str: 'success' },
              outputs: {
                '8': { images: [{ filename: `${name}.png`, subfolder: '', type: 'output' }] },
              },
            },
          }),
          { status: 200 },
        );
      }
      if (urlStr.includes('/view?')) {
        return new Response(Buffer.from('image'), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const generator = new ComfyUiGenerator(baseConfig);

    const p1 = generator.generate('first');
    const p2 = generator.generate('second');

    await Promise.all([p1, p2]);

    expect(executionOrder).toEqual(['start-first', 'end-first', 'start-second', 'end-second']);
  });
});
