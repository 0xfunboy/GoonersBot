import { afterEach, describe, expect, it, vi } from 'vitest';
import { StableDiffusionGenerator } from '../src/providers/image/stableDiffusion.js';

describe('StableDiffusionGenerator', () => {
  afterEach(() => vi.restoreAllMocks());

  it('selects a model profile, applies it once and decodes txt2img output', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/sd-models')) {
        return new Response(
          JSON.stringify([
            { title: 'sd\\waiIllustriousSDXL_v170.safetensors [anime]' },
            { title: 'sd\\majicmixRealistic_v7.safetensors [real]' },
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
      animeModel: 'waiIllustriousSDXL_v170.safetensors',
      realisticModel: 'majicmixRealistic_v7.safetensors',
      nsfwModel: 'ponyDiffusionV6XL_v6StartWithThisOne.safetensors',
      negativePrompt: 'bad anatomy',
      steps: 28,
      width: 768,
      height: 768,
      cfgScale: 6.5,
      timeoutMs: 1_000,
    });

    const first = await generator.generate('anime hacker waifu');
    const second = await generator.generate('anime hacker waifu, neon terminal');

    expect(first.buffer?.toString()).toBe('image-bytes');
    expect(second.buffer?.toString()).toBe('image-bytes');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://sd.test:7860/sdapi/v1/sd-models');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://sd.test:7860/sdapi/v1/options');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('http://sd.test:7860/sdapi/v1/txt2img');
    expect(fetchMock.mock.calls[3]?.[0]).toBe('http://sd.test:7860/sdapi/v1/txt2img');
    expect(fetchMock.mock.calls[2]?.[1]?.body).toContain('detailed anime illustration');
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
    });

    await generator.generate('explicit nude adult anime woman');

    expect(fetchMock.mock.calls[1]?.[1]?.body).toContain('ponyDiffusionV6XL');
    expect(fetchMock.mock.calls[2]?.[1]?.body).toContain('rating_explicit');
    expect(fetchMock.mock.calls[2]?.[1]?.body).toContain('underage, child, loli, shota');
  });
});
