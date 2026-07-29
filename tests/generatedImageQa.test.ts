import { describe, expect, it, vi } from 'vitest';
import { MediaProcessor } from '../src/providers/media/index.js';
import type { ImageGenerator } from '../src/providers/image/stableDiffusion.js';
import type { LLMProvider } from '../src/providers/llm/types.js';

function visionLlm(results: string[]): LLMProvider {
  const queue = [...results];
  return {
    name: 'vision-test',
    capabilities: {
      chat: true,
      vision: true,
      transcription: false,
      imageGeneration: false,
      tts: false,
      embeddings: false,
    },
    visionCompletion: vi.fn(async () => ({
      text: queue.shift() ?? '',
      model: 'vision',
      usage: { estimated: true },
    })),
  } as unknown as LLMProvider;
}

describe('generated-image visual QA', () => {
  it('keeps a good first result without another generation', async () => {
    const generate = vi.fn(async () => ({
      buffer: Buffer.from('small-image'),
      model: 'agnes-image-2.1-flash',
    }));
    const media = new MediaProcessor(
      visionLlm([
        '{"score":88,"hardFailure":false,"visibleContentRating":"safe","visibleSummary":"correct","issues":[],"correction":""}',
      ]),
      undefined,
      undefined,
      { enabled: true, generate } as ImageGenerator,
      { enabled: true, minScore: 0.72, maxRetries: 1 },
    );

    const result = await media.generateImage('safe prompt', {
      qualityBrief: 'one adult mechanic, close-up',
    });

    expect(result?.model).toBe('agnes-image-2.1-flash');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('uses one focused retry on the other backend and returns the better candidate', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({
        buffer: Buffer.from('first-small-image'),
        model: 'ponyDiffusionV6XL',
        provider: 'pony',
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from('second-small-image'),
        model: 'agnes-image-2.1-flash',
        provider: 'agnes',
      });
    const media = new MediaProcessor(
      visionLlm([
        '{"score":35,"hardFailure":true,"visibleContentRating":"safe","visibleSummary":"four people","issues":["two extra people"],"correction":"Show exactly the two requested subjects and nobody else"}',
        '{"score":91,"hardFailure":false,"visibleContentRating":"safe","visibleSummary":"two subjects","issues":[],"correction":""}',
      ]),
      undefined,
      undefined,
      { enabled: true, generate } as ImageGenerator,
      { enabled: true, minScore: 0.72, maxRetries: 1 },
    );

    const result = await media.generateImage('safe prompt', {
      qualityBrief: 'exactly two requested adult subjects',
      preferredProvider: 'pony',
    });

    expect(result?.model).toBe('agnes-image-2.1-flash');
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        preferredProvider: 'agnes',
        retryFeedback: expect.stringContaining('exactly the two requested subjects'),
      }),
    );
  });

  it('recovers a compact vision response with one missing issues quote', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({
        buffer: Buffer.from('first'),
        model: 'pony-first',
        provider: 'pony',
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from('second'),
        model: 'agnes-corrected',
        provider: 'agnes',
      });
    const media = new MediaProcessor(
      visionLlm([
        '{"score":45,"hardFailure":false,"visibleSummary":"wrong framing","ageSafety":"adult_only","visibleContentRating":"safe","issues":["armor too shiny and framing too wide],correction":"Use matte armor and an upper-body portrait."}',
        '{"score":90,"hardFailure":false,"visibleSummary":"correct","ageSafety":"adult_only","visibleContentRating":"safe","issues":[],"correction":""}',
      ]),
      undefined,
      undefined,
      { enabled: true, generate } as ImageGenerator,
      { enabled: true, minScore: 0.72, maxRetries: 1 },
    );

    const result = await media.generateImage('safe warrior portrait', {
      qualityBrief: 'one adult warrior, matte armor, upper-body portrait',
      rating: 'safe',
      preferredProvider: 'pony',
    });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        preferredProvider: 'agnes',
        retryFeedback: expect.stringMatching(/matte armor|too shiny/i),
      }),
    );
    expect(result?.model).toBe('agnes-corrected');
    expect(result?.qaScore).toBe(90);
  });

  it('treats severe anatomy issues as hard and keeps an Agnes-first correction on Agnes', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({
        buffer: Buffer.from('first'),
        model: 'agnes-first',
        provider: 'agnes',
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from('second'),
        model: 'agnes-corrected',
        provider: 'agnes',
      });
    const media = new MediaProcessor(
      visionLlm([
        '{"score":75,"hardFailure":false,"ageSafety":"adult_only","visibleContentRating":"safe","visibleSummary":"mostly correct","issues":["extra fingers in the left hand"],"correction":"Fix the hand anatomy."}',
        '{"score":93,"hardFailure":false,"ageSafety":"adult_only","visibleContentRating":"safe","visibleSummary":"correct","issues":[],"correction":""}',
      ]),
      undefined,
      undefined,
      { enabled: true, generate } as ImageGenerator,
      { enabled: true, minScore: 0.72, maxRetries: 1 },
    );

    const result = await media.generateImage('dense safe photo', {
      qualityBrief: 'one mechanic with exact hand placement',
      rating: 'safe',
      preferredProvider: 'agnes',
    });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        preferredProvider: 'agnes',
        retryFeedback: expect.stringMatching(/hand anatomy|extra fingers/i),
      }),
    );
    expect(result?.model).toBe('agnes-corrected');
  });

  it('keeps the first valid artifact when the corrective backend fails', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({
        buffer: Buffer.from('first-small-image'),
        model: 'agnes-image',
        provider: 'agnes',
      })
      .mockRejectedValueOnce(new Error('Forge offline'));
    const media = new MediaProcessor(
      visionLlm([
        '{"score":35,"hardFailure":true,"visibleContentRating":"safe","visibleSummary":"wrong subject","issues":["missing robot"],"correction":"add the robot"}',
      ]),
      undefined,
      undefined,
      { enabled: true, generate } as ImageGenerator,
      { enabled: true, minScore: 0.72, maxRetries: 1 },
    );

    const result = await media.generateImage('safe prompt', {
      qualityBrief: 'one adult and one robot',
    });

    expect(result?.model).toBe('agnes-image');
    expect(result?.generationAttempts).toBe(2);
    expect(result?.qaVisionCalls).toBe(1);
  });

  it('prefers a non-hard-failure candidate over a higher-scored structurally wrong one', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({
        buffer: Buffer.from('first'),
        model: 'agnes-image',
        provider: 'agnes',
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from('second'),
        model: 'pony-checkpoint',
        provider: 'pony',
      });
    const media = new MediaProcessor(
      visionLlm([
        '{"score":"90","hard_failure":"true","visibleContentRating":"safe","visibleSummary":"extra person","issues":"wrong subject count","correction":"remove extra person"}',
        '{"score":65,"hardFailure":false,"visibleContentRating":"safe","visibleSummary":"right structure","issues":["minor color mismatch"],"correction":""}',
      ]),
      undefined,
      undefined,
      { enabled: true, generate } as ImageGenerator,
      { enabled: true, minScore: 0.72, maxRetries: 1 },
    );

    const result = await media.generateImage('safe prompt', {
      qualityBrief: 'exactly two adults',
    });

    expect(result?.model).toBe('pony-checkpoint');
    expect(result?.qaScore).toBe(65);
    expect(result?.generationAttempts).toBe(2);
    expect(result?.qaVisionCalls).toBe(2);
  });

  it('keeps explicit corrective retries on Pony', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({
        buffer: Buffer.from('first'),
        model: 'pony-checkpoint',
        provider: 'pony',
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from('second'),
        model: 'pony-checkpoint',
        provider: 'pony',
      });
    const media = new MediaProcessor(
      visionLlm([
        '{"score":20,"hardFailure":true,"ageSafety":"adult_only","visibleContentRating":"explicit","visibleSummary":"wrong","issues":["wrong framing"],"correction":"fix framing"}',
        '{"score":80,"hardFailure":false,"ageSafety":"adult_only","visibleContentRating":"explicit","visibleSummary":"correct","issues":[],"correction":""}',
      ]),
      undefined,
      undefined,
      { enabled: true, generate } as ImageGenerator,
      { enabled: true, minScore: 0.72, maxRetries: 1 },
    );

    await media.generateImage('explicit adult prompt', {
      qualityBrief: 'explicit adult scene',
      rating: 'explicit',
    });

    expect(generate.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ preferredProvider: 'pony' }),
    );
  });

  it('allows an explicit object-only scene when vision confirms there are no people', async () => {
    const generate = vi.fn(async () => ({
      buffer: Buffer.from('adult-graffiti'),
      model: 'pony-checkpoint',
      provider: 'pony' as const,
    }));
    const media = new MediaProcessor(
      visionLlm([
        '{"score":88,"hardFailure":false,"ageSafety":"no_people","visibleContentRating":"explicit","visibleSummary":"explicit anatomical graffiti on an empty wall","issues":[],"correction":""}',
      ]),
      undefined,
      undefined,
      { enabled: true, generate } as ImageGenerator,
      { enabled: true, minScore: 0.72, maxRetries: 1 },
    );

    const result = await media.generateImage('explicit anatomical graffiti on a concrete wall', {
      qualityBrief: 'an explicit anatomical graffiti drawing on an empty wall, no people',
      rating: 'explicit',
      expectsPeople: false,
    });

    expect(generate).toHaveBeenCalledOnce();
    expect(result?.buffer?.toString()).toBe('adult-graffiti');
  });

  it('does not deliver an explicit bitmap whose visible age is ambiguous', async () => {
    const generate = vi.fn(async () => ({
      buffer: Buffer.from('ambiguous'),
      model: 'pony-checkpoint',
      provider: 'pony' as const,
    }));
    const media = new MediaProcessor(
      visionLlm([
        '{"score":85,"hardFailure":false,"ageSafety":"ambiguous_or_minor","visibleContentRating":"explicit","visibleSummary":"young-looking person","issues":[],"correction":"depict an unmistakably mature adult"}',
        '{"score":88,"hardFailure":false,"ageSafety":"ambiguous_or_minor","visibleContentRating":"explicit","visibleSummary":"still age ambiguous","issues":[],"correction":""}',
      ]),
      undefined,
      undefined,
      { enabled: true, generate } as ImageGenerator,
      { enabled: true, minScore: 0.72, maxRetries: 1 },
    );

    const result = await media.generateImage('explicit adult prompt', {
      qualityBrief: 'one unambiguously mature adult',
      rating: 'explicit',
    });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result).toBeNull();
  });

  it('requires visible adulthood for suggestive images too', async () => {
    const generate = vi.fn(async () => ({
      buffer: Buffer.from('ambiguous'),
      model: 'pony-checkpoint',
      provider: 'pony' as const,
    }));
    const media = new MediaProcessor(
      visionLlm([
        '{"score":90,"hardFailure":false,"ageSafety":"not_assessed","visibleContentRating":"suggestive","visibleSummary":"person in lingerie","issues":[],"correction":"make the subject visibly mature"}',
        '{"score":95,"hardFailure":false,"ageSafety":"not_assessed","visibleContentRating":"suggestive","visibleSummary":"person in lingerie","issues":[],"correction":""}',
      ]),
      undefined,
      undefined,
      { enabled: true, generate } as ImageGenerator,
      { enabled: true, minScore: 0.72, maxRetries: 1 },
    );

    const result = await media.generateImage('suggestive adult prompt', {
      qualityBrief: 'one unambiguously mature adult in lingerie',
      rating: 'suggestive',
    });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result).toBeNull();
  });

  it('never delivers a bitmap that vision identifies as minor or age-ambiguous', async () => {
    const generate = vi.fn(async () => ({
      buffer: Buffer.from('ambiguous'),
      model: 'agnes-image',
      provider: 'agnes' as const,
    }));
    const media = new MediaProcessor(
      visionLlm([
        '{"score":85,"hardFailure":false,"ageSafety":"ambiguous_or_minor","visibleContentRating":"safe","visibleSummary":"young-looking person","issues":[],"correction":"depict a mature adult"}',
        '{"score":88,"hardFailure":false,"ageSafety":"ambiguous_or_minor","visibleContentRating":"safe","visibleSummary":"still age ambiguous","issues":[],"correction":""}',
      ]),
      undefined,
      undefined,
      { enabled: true, generate } as ImageGenerator,
      { enabled: true, minScore: 0.72, maxRetries: 1 },
    );

    const result = await media.generateImage('safe portrait', {
      qualityBrief: 'one adult portrait',
      rating: 'safe',
    });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result).toBeNull();
  });

  it('never delivers unexpected explicit content for a safe request', async () => {
    const generate = vi.fn(async () => ({
      buffer: Buffer.from('unexpected-explicit'),
      model: 'image-provider',
      provider: 'agnes' as const,
    }));
    const media = new MediaProcessor(
      visionLlm([
        '{"score":92,"hardFailure":false,"ageSafety":"adult_only","visibleContentRating":"explicit","visibleSummary":"explicit adult nudity","issues":[],"correction":""}',
        '{"score":90,"hardFailure":false,"ageSafety":"adult_only","visibleContentRating":"explicit","visibleSummary":"explicit adult nudity remains","issues":[],"correction":""}',
      ]),
      undefined,
      undefined,
      { enabled: true, generate } as ImageGenerator,
      { enabled: true, minScore: 0.72, maxRetries: 1 },
    );

    const result = await media.generateImage('safe fully clothed portrait', {
      qualityBrief: 'one fully clothed adult portrait, safe content',
      rating: 'safe',
    });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        retryFeedback: expect.stringMatching(/fully clothed|safe content/i),
      }),
    );
    expect(result).toBeNull();
  });

  it.each(['suggestive', 'explicit'] as const)(
    'fails closed for %s output when visual QA is disabled',
    async (rating) => {
      const generate = vi.fn(async () => ({
        buffer: Buffer.from('unverified'),
        model: 'pony',
        provider: 'pony' as const,
      }));
      const media = new MediaProcessor(
        visionLlm([]),
        undefined,
        undefined,
        { enabled: true, generate } as ImageGenerator,
        { enabled: false, minScore: 0.72, maxRetries: 1 },
      );

      const result = await media.generateImage('adult image', {
        qualityBrief: 'one unambiguously mature adult',
        rating,
      });

      expect(generate).toHaveBeenCalledOnce();
      expect(result).toBeNull();
    },
  );

  it('does not return an artifact after caller cancellation during vision QA', async () => {
    const controller = new AbortController();
    const llm = visionLlm([]);
    llm.visionCompletion = vi.fn(async () => {
      controller.abort(new Error('caller cancelled'));
      throw controller.signal.reason;
    });
    const media = new MediaProcessor(
      llm,
      undefined,
      undefined,
      {
        enabled: true,
        generate: vi.fn(async () => ({
          buffer: Buffer.from('image'),
          model: 'agnes',
          provider: 'agnes' as const,
        })),
      },
      { enabled: true, minScore: 0.72, maxRetries: 1 },
    );

    const result = await media.generateImage('safe image', {
      qualityBrief: 'one adult',
      rating: 'safe',
      signal: controller.signal,
    });

    expect(result).toBeNull();
  });

  it('prefers an adult-verified retry over an age-ambiguous higher score', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({
        buffer: Buffer.from('ambiguous'),
        model: 'pony-first',
        provider: 'pony',
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from('adult'),
        model: 'pony-adult',
        provider: 'pony',
      });
    const media = new MediaProcessor(
      visionLlm([
        '{"score":95,"hardFailure":false,"ageSafety":"ambiguous_or_minor","visibleContentRating":"suggestive","visibleSummary":"age ambiguous","issues":[],"correction":"make visibly adult"}',
        '{"score":60,"hardFailure":true,"ageSafety":"adult_only","visibleContentRating":"suggestive","visibleSummary":"adult with framing mismatch","issues":["wrong framing"],"correction":""}',
      ]),
      undefined,
      undefined,
      { enabled: true, generate } as ImageGenerator,
      { enabled: true, minScore: 0.72, maxRetries: 1 },
    );

    const result = await media.generateImage('suggestive adult portrait', {
      qualityBrief: 'one mature adult',
      rating: 'suggestive',
    });

    expect(result?.model).toBe('pony-adult');
    expect(result?.qaScore).toBe(60);
  });

  it('materializes a generic LLM data URL and preserves natural prompt plus aspect ratio', async () => {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const generateImage = vi.fn(async () => ({
      url: `data:image/png;base64,${png.toString('base64')}`,
      model: 'generic-image',
      provider: 'llm' as const,
    }));
    const llm = {
      capabilities: {
        chat: true,
        vision: false,
        transcription: false,
        imageGeneration: true,
        tts: false,
        embeddings: false,
      },
      generateImage,
    } as unknown as LLMProvider;
    const media = new MediaProcessor(llm, undefined, undefined, undefined, {
      enabled: false,
      minScore: 0.72,
      maxRetries: 1,
    });

    const result = await media.generateImage('legacy pony prompt', {
      providerPrompts: {
        agnes: 'natural instruction-following prompt',
        pony: 'pony tags',
      },
      aspectRatio: '9:16',
      rating: 'safe',
    });

    expect(result?.buffer).toEqual(png);
    expect(result?.mime).toBe('image/png');
    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'natural instruction-following prompt',
        size: '1024x1792',
      }),
    );
  });

  it('does not bypass adult-only QA through the generic LLM image fallback', async () => {
    const generateImage = vi.fn(async () => ({
      buffer: Buffer.from('unverified'),
      model: 'generic-image',
      provider: 'llm' as const,
    }));
    const llm = {
      capabilities: {
        chat: true,
        vision: false,
        transcription: false,
        imageGeneration: true,
        tts: false,
        embeddings: false,
      },
      generateImage,
    } as unknown as LLMProvider;
    const media = new MediaProcessor(llm, undefined, undefined, undefined, {
      enabled: true,
      minScore: 0.72,
      maxRetries: 1,
    });

    const result = await media.generateImage('suggestive adult portrait', {
      qualityBrief: 'one unambiguously mature adult',
      rating: 'suggestive',
    });

    expect(generateImage).toHaveBeenCalledOnce();
    expect(result).toBeNull();
  });
});
