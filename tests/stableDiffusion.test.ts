import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  selectImageProfile,
  StableDiffusionGenerator,
} from '../src/providers/image/stableDiffusion.js';

describe('StableDiffusionGenerator', () => {
  afterEach(() => vi.restoreAllMocks());

  it('routes Italian explicit requests to the NSFW profile', () => {
    expect(selectImageProfile('boop user con un cazzo in bocca')).toBe('nsfw');
    expect(selectImageProfile('score_9, rating_explicit, source_anime, adult woman')).toBe('nsfw');
    expect(selectImageProfile('una waifu hacker al computer')).toBe('anime');
  });

  it('uses a dedicated manga workflow for forced drawing requests', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/sd-models')) {
        return new Response(
          JSON.stringify([{ title: 'ponyDiffusionV6XL_v6StartWithThisOne.safetensors' }]),
          {
            status: 200,
          },
        );
      }
      if (url.endsWith('/options')) return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ images: [Buffer.from('image').toString('base64')] }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const generator = new StableDiffusionGenerator({
      enabled: true,
      apiUrl: 'http://sd.test:7860',
      animeModel: 'ponyDiffusionV6XL_v6StartWithThisOne.safetensors',
      realisticModel: 'ponyDiffusionV6XL_v6StartWithThisOne.safetensors',
      nsfwModel: 'pony.safetensors',
      negativePrompt: 'bad anatomy',
      steps: 28,
      width: 768,
      height: 768,
      cfgScale: 6.5,
      timeoutMs: 1_000,
      queueTimeoutMs: 1_000,
      queuePollMs: 1,
      controlNet: {
        enabled: true,
        openPoseModel: 'OpenPoseXL2',
        weight: 0.85,
        processorResolution: 512,
      },
    });

    await generator.generate('1girl, 1boy, convenience store', {
      profile: 'manga',
      poseReference: Buffer.from('pose-reference'),
    });

    const body = String(fetchMock.mock.calls.at(-1)?.[1]?.body);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://sd.test:7860/sdapi/v1/img2img');
    expect(body).toContain('Euler a');
    expect(body).toContain('832');
    expect(body).toContain('processor_res":512');
    expect(body).toContain('two separate characters');
    expect(body).toContain('alwayson_scripts');
    expect(body).toContain('OpenPoseXL2');
    expect(body).toContain('init_images');
  });

  it('selects a model profile, applies it once and decodes txt2img output', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/sd-models')) {
        return new Response(
          JSON.stringify([
            { title: 'sd\\ponyDiffusionV6XL_v6StartWithThisOne.safetensors [pony]' },
          ]),
          { status: 200 },
        );
      }
      if (url.endsWith('/options')) return new Response('{}', { status: 200 });
      return new Response(
        JSON.stringify({ images: [Buffer.from('image-bytes').toString('base64')] }),
        {
          status: 200,
        },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const generator = new StableDiffusionGenerator({
      enabled: true,
      apiUrl: 'http://sd.test:7860',
      animeModel: 'ponyDiffusionV6XL_v6StartWithThisOne.safetensors',
      realisticModel: 'ponyDiffusionV6XL_v6StartWithThisOne.safetensors',
      nsfwModel: 'ponyDiffusionV6XL_v6StartWithThisOne.safetensors',
      negativePrompt: 'bad anatomy',
      steps: 28,
      width: 768,
      height: 768,
      cfgScale: 6.5,
      timeoutMs: 1_000,
      queueTimeoutMs: 1_000,
      queuePollMs: 1,
      controlNet: {
        enabled: true,
        openPoseModel: 'OpenPoseXL2',
        weight: 0.85,
        processorResolution: 512,
      },
    });

    const first = await generator.generate('anime hacker waifu');
    const second = await generator.generate('anime hacker waifu, neon terminal');

    expect(first.buffer?.toString()).toBe('image-bytes');
    expect(second.buffer?.toString()).toBe('image-bytes');
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://sd.test:7860/sdapi/v1/sd-models');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://sd.test:7860/sdapi/v1/progress');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('http://sd.test:7860/sdapi/v1/options');
    expect(fetchMock.mock.calls[3]?.[0]).toBe('http://sd.test:7860/sdapi/v1/options');
    expect(fetchMock.mock.calls[4]?.[0]).toBe('http://sd.test:7860/sdapi/v1/txt2img');
    expect(fetchMock.mock.calls[5]?.[0]).toBe('http://sd.test:7860/sdapi/v1/progress');
    expect(fetchMock.mock.calls[6]?.[0]).toBe('http://sd.test:7860/sdapi/v1/txt2img');
    expect(fetchMock.mock.calls[4]?.[1]?.body).toContain('score_9, score_8_up');
  });

  it('routes explicit adult prompts to the Pony checkpoint', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/sd-models')) {
        return new Response(
          JSON.stringify([{ title: 'ponyDiffusionV6XL_v6StartWithThisOne.safetensors' }]),
          { status: 200 },
        );
      }
      if (url.endsWith('/options')) return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ images: [Buffer.from('image').toString('base64')] }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const generator = new StableDiffusionGenerator({
      enabled: true,
      apiUrl: 'http://sd.test:7860',
      animeModel: 'anime.safetensors',
      realisticModel: 'real.safetensors',
      nsfwModel: 'ponyDiffusionV6XL_v6StartWithThisOne.safetensors',
      negativePrompt: 'bad anatomy',
      steps: 28,
      width: 768,
      height: 768,
      cfgScale: 6.5,
      timeoutMs: 1_000,
      queueTimeoutMs: 1_000,
      queuePollMs: 1,
      controlNet: {
        enabled: true,
        openPoseModel: 'OpenPoseXL2',
        weight: 0.85,
        processorResolution: 512,
      },
    });

    await generator.generate('explicit nude adult anime woman');

    expect(fetchMock.mock.calls[3]?.[1]?.body).toContain('ponyDiffusionV6XL');
    expect(fetchMock.mock.calls[4]?.[1]?.body).toContain('rating_explicit');
    expect(fetchMock.mock.calls[4]?.[1]?.body).toContain('underage, child, loli, shota');
  });
});
