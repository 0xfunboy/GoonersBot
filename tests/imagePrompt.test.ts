import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/index.js';
import type { LLMProvider } from '../src/providers/llm/types.js';
import {
  ImagePromptService,
  imageSceneDraftSchema,
  inferImageContentRating,
  inferImageMedium,
} from '../src/services/imagePrompt.js';

function scene(overrides: Record<string, unknown> = {}): unknown {
  return {
    objective: 'Create the requested scene',
    medium: 'digital_illustration',
    contentRating: 'safe',
    aspectRatio: '1:1',
    subjects: [
      {
        count: 1,
        kind: 'adult woman',
        description: 'adult woman with dark hair',
        action: 'standing',
        position: 'center frame',
      },
    ],
    interaction: '',
    composition: {
      shot: 'medium shot',
      angle: 'eye level',
      lens: '50mm',
      focus: 'main subject',
    },
    setting: 'city street',
    lighting: 'soft evening light',
    palette: 'blue and amber',
    mood: 'cinematic',
    importantDetails: [],
    mustInclude: [],
    mustAvoid: [],
    exactText: null,
    ...overrides,
  };
}

function promptLlm(result: unknown): {
  llm: LLMProvider;
  jsonCompletion: ReturnType<typeof vi.fn>;
} {
  const jsonCompletion = vi.fn(async () => imageSceneDraftSchema.parse(result));
  return {
    llm: { jsonCompletion } as unknown as LLMProvider,
    jsonCompletion,
  };
}

describe('ImagePromptService', () => {
  it('separates explicit rating from medium and uses the requested prompt model', async () => {
    const { llm, jsonCompletion } = promptLlm(
      scene({
        medium: 'anime',
        contentRating: 'explicit',
        subjects: [
          {
            count: 1,
            kind: 'adult woman',
            description: 'unambiguously adult woman',
            action: 'the requested adult action',
            position: 'center frame',
          },
        ],
      }),
    );
    const config = {
      llm: { model: 'default-llm', nsfwModel: 'nsfw-llm' },
    } as AppConfig;

    const result = await new ImagePromptService(llm, config).prepare(
      'una donna adulta in una scena sessuale esplicita',
    );

    expect(result.profile).toBe('nsfw');
    expect(result.rating).toBe('explicit');
    expect(result.medium).toBe('anime');
    expect(result.preferredProvider).toBe('pony');
    expect(result.negativePrompt).toContain('censored');
    expect(jsonCompletion).toHaveBeenCalledWith(expect.objectContaining({ model: 'default-llm' }));
  });

  it('keeps a forced manga medium while routing explicit adult content to Pony', async () => {
    const { llm, jsonCompletion } = promptLlm(
      scene({
        medium: 'manga',
        contentRating: 'explicit',
        aspectRatio: '9:16',
        subjects: [
          {
            count: 2,
            kind: 'adult characters',
            description: 'two unambiguously adult manga characters',
            action: 'performing the requested explicit adult interaction',
            position: 'center frame',
          },
        ],
        composition: {
          shot: 'full-body shot',
          angle: 'eye level',
          lens: 'manga perspective',
          focus: 'both adult characters and their interaction',
        },
      }),
    );

    const result = await new ImagePromptService(llm, {
      llm: { model: 'planner' },
    } as AppConfig).prepare('tavola manga verticale esplicita con due adulti, a figura intera', {
      profile: 'manga',
    });

    expect(result.profile).toBe('manga');
    expect(result.medium).toBe('manga');
    expect(result.rating).toBe('explicit');
    expect(result.aspectRatio).toBe('9:16');
    expect(result.preferredProvider).toBe('pony');
    expect(result.providerPrompts.agnes).toContain('professional manga illustration');
    expect(result.providerPrompts.agnes).toContain(
      'entire subject from head through both feet is visible',
    );
    expect(result.providerPrompts.pony).toContain('(exactly 2 subjects:1.5)');
    expect(result.negativePrompt).toContain('underage');
    expect(result.negativePrompt).not.toContain('rating_explicit');
    expect(jsonCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('LOCKED CONTENT RATING: explicit'),
      }),
    );
  });

  it('honors a group-plan model override', async () => {
    const { llm, jsonCompletion } = promptLlm(scene());
    const service = new ImagePromptService(llm, { llm: { model: 'premium-model' } } as AppConfig);

    await service.prepare('una donna adulta in città', { model: 'economy-model' });
    expect(jsonCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'economy-model' }),
    );
  });

  it('keeps Italian explicit acts meaningful when structured planning fails', async () => {
    const llm = {
      jsonCompletion: vi.fn(async () => {
        throw new Error('backend unavailable');
      }),
    } as unknown as LLMProvider;
    const config = {
      llm: { model: 'default-llm', nsfwModel: 'nsfw-llm' },
    } as AppConfig;

    const result = await new ImagePromptService(llm, config).prepare(
      'una donna adulta con un cazzo in bocca',
    );

    expect(result.usedFallback).toBe(true);
    expect(result.providerPrompts.pony).toContain('penis in mouth, oral sex, blowjob');
    expect(result.rating).toBe('explicit');
  });

  it('adds exact two-subject constraints to a fallback prompt', async () => {
    const llm = {
      jsonCompletion: vi.fn(async () => {
        throw new Error('backend unavailable');
      }),
    } as unknown as LLMProvider;
    const config = { llm: { model: 'default-llm' } } as AppConfig;

    const result = await new ImagePromptService(llm, config).prepare(
      'soggetto 1 sulle spalle del soggetto 2, entrambi adulti, strada di notte',
    );

    expect(result.scene.requestedSubjectCount).toBe(2);
    expect(result.providerPrompts.pony).toContain('(exactly 2 subjects:1.5)');
    expect(result.providerPrompts.agnes).toContain('exactly two main subjects');
    expect(result.negativePrompt).toContain('extra subjects');
  });

  it('keeps a named second subject when the prompt model falls back', async () => {
    const llm = {
      jsonCompletion: vi.fn(async () => {
        throw new Error('backend unavailable');
      }),
    } as unknown as LLMProvider;
    const config = { llm: { model: 'default-llm' } } as AppConfig;

    const result = await new ImagePromptService(llm, config).prepare(
      'woman laying a brown egg over @Daniele',
    );

    expect(result.scene.requestedSubjectCount).toBe(2);
    expect(result.providerPrompts.pony).toContain('(exactly 2 subjects:1.5)');
    expect(result.providerPrompts.pony).toContain('adult man');
  });

  it('does not turn a place name after above/over into a second subject', async () => {
    const { llm } = promptLlm(
      scene({
        subjects: [
          {
            count: 1,
            kind: 'drone',
            description: 'a camera drone',
            action: 'flying above Rome',
            position: 'center',
          },
        ],
      }),
    );

    const result = await new ImagePromptService(llm, {
      llm: { model: 'planner' },
    } as AppConfig).prepare('a drone flying above Rome at sunset');

    expect(result.scene.requestedSubjectCount).not.toBe(2);
    expect(result.scene.subjects).toHaveLength(1);
    expect(result.providerPrompts.agnes).toContain('exactly one main subject');
  });

  it('does not duplicate a person merely because they fly above a named city', async () => {
    const { llm } = promptLlm(
      scene({
        subjects: [
          {
            count: 1,
            kind: 'adult woman',
            description: 'one adult superhero',
            action: 'flying above Rome',
            position: 'center',
          },
        ],
      }),
    );

    const result = await new ImagePromptService(llm, {
      llm: { model: 'planner' },
    } as AppConfig).prepare('an adult woman flying above Rome at sunset');

    expect(result.scene.requestedSubjectCount).not.toBe(2);
    expect(result.scene.subjects).toHaveLength(1);
    expect(result.providerPrompts.agnes).toContain('exactly one main subject');
  });

  it('preserves a close-up and moves user exclusions out of the positive Pony prompt', async () => {
    const { llm } = promptLlm(
      scene({
        medium: 'photo',
        aspectRatio: '9:16',
        subjects: [
          {
            count: 1,
            kind: 'adult male mechanic',
            description: 'gray beard, green eyes, clear goggles, no hat',
            action: 'looking at camera',
            position: 'centered',
          },
        ],
        composition: {
          shot: 'close-up',
          angle: 'eye level',
          lens: '85mm',
          focus: 'eyes',
        },
        mustInclude: ['gray beard', 'no hat'],
        mustAvoid: ['hat'],
      }),
    );

    const result = await new ImagePromptService(llm, {
      llm: { model: 'planner' },
    } as AppConfig).prepare(
      'ritratto fotografico ravvicinato di un meccanico adulto con barba grigia, senza cappello, verticale',
    );

    expect(result.aspectRatio).toBe('9:16');
    expect(result.providerPrompts.pony).toContain('close-up');
    expect(result.providerPrompts.pony).not.toMatch(/\bno hat\b/i);
    expect(result.negativePrompt).toContain('hat');
    expect(result.providerPrompts.agnes).toContain('Exclude: hat');
  });

  it('compiles anatomical left/right into explicit viewer-side Agnes placement', async () => {
    const { llm } = promptLlm(
      scene({
        medium: 'photo',
        subjects: [
          {
            count: 1,
            kind: 'adult male mechanic',
            description: 'mature mechanic in blue overalls',
            action: 'holding a wrench in his left hand',
            position: 'front-facing',
          },
        ],
        interaction:
          "His left hand holds the wrench on the viewer's right; his right hand rests on a bench on the viewer's left",
        composition: {
          shot: 'full-body shot',
          angle: 'eye level',
          lens: 'standard lens',
          focus: 'the mechanic',
        },
      }),
    );

    const result = await new ImagePromptService(llm, {
      llm: { model: 'planner' },
    } as AppConfig).prepare(
      'foto a figura intera di un meccanico adulto: chiave nella mano sinistra, che appare a destra per chi guarda',
    );

    expect(result.providerPrompts.agnes).toContain('HIGHEST-PRIORITY SPATIAL LAYOUT');
    expect(result.providerPrompts.agnes).toContain('hand on the RIGHT side of the image');
    expect(result.providerPrompts.agnes).toContain('hand on the LEFT side of the image');
    expect(result.qualityBrief).toContain('Required viewer-coordinate placement');
    expect(result.providerPrompts.agnes).toContain('shoes fully inside the canvas');
  });

  it('preserves composite subject totals instead of treating one numeric phrase as the total', async () => {
    const { llm } = promptLlm(
      scene({
        subjects: [
          {
            count: 1,
            kind: 'adult woman',
            description: 'one adult woman in a red coat',
            action: 'walking',
            position: 'left',
          },
          {
            count: 2,
            kind: 'adult men',
            description: 'two adult men in blue coats',
            action: 'walking',
            position: 'right',
          },
        ],
      }),
    );

    const result = await new ImagePromptService(llm, {
      llm: { model: 'planner' },
    } as AppConfig).prepare('one woman and two men walking together');

    expect(result.scene.requestedSubjectCount).toBe(3);
    expect(result.scene.subjects.map((subject) => subject.count)).toEqual([1, 2]);
    expect(result.providerPrompts.agnes).toContain('exactly three main subjects');
    expect(result.providerPrompts.pony).toContain('1girl');
    expect(result.providerPrompts.pony).toContain('2men');
    expect(result.providerPrompts.pony).not.toContain('(duo:1.3)');
  });

  it.each([
    ['a woman and two men walking together', 3, [1, 2]],
    ['one woman standing beside a robot', 2, [1, 1]],
  ] as const)(
    'counts English indefinite articles in composite subjects: %s',
    async (request, total, counts) => {
      const { llm } = promptLlm(
        scene({
          subjects: [
            {
              count: 1,
              kind: 'adult woman',
              description: 'one adult woman',
              action: 'standing',
              position: 'left',
            },
            {
              count: counts[1],
              kind: request.includes('robot') ? 'robot' : 'adult men',
              description: request.includes('robot') ? 'one humanoid robot' : 'two adult men',
              action: 'standing',
              position: 'right',
            },
          ],
        }),
      );

      const result = await new ImagePromptService(llm, {
        llm: { model: 'planner' },
      } as AppConfig).prepare(request);

      expect(result.scene.requestedSubjectCount).toBe(total);
      expect(result.scene.subjects.map((subject) => subject.count)).toEqual([...counts]);
    },
  );

  it.each([
    'one woman and two men; the two men wear blue',
    'una donna e due uomini; i due uomini vestono di blu',
  ])('does not double-count a repeated numeric subject reference: %s', async (request) => {
    const { llm } = promptLlm(
      scene({
        subjects: [
          {
            count: 1,
            kind: 'adult woman',
            description: 'one adult woman',
            action: 'standing',
            position: 'left',
          },
          {
            count: 2,
            kind: 'adult men',
            description: 'two adult men wearing blue',
            action: 'standing',
            position: 'right',
          },
        ],
      }),
    );

    const result = await new ImagePromptService(llm, {
      llm: { model: 'planner' },
    } as AppConfig).prepare(request);

    expect(result.scene.subjects.map((subject) => subject.count)).toEqual([1, 2]);
    expect(result.providerPrompts.agnes).toContain('exactly three main subjects');
  });

  it.each([
    ['one woman and one horse', 2, 'exactly two main subjects'],
    ['one woman and three drones', 4, 'exactly four main subjects'],
  ] as const)(
    'never truncates draft subjects when a counted type is outside the parser lexicon: %s',
    async (request, total, agnesText) => {
      const secondaryCount = total - 1;
      const { llm } = promptLlm(
        scene({
          subjects: [
            {
              count: 1,
              kind: 'adult woman',
              description: 'one adult woman',
              action: 'standing',
              position: 'left',
            },
            {
              count: secondaryCount,
              kind: request.includes('horse') ? 'horse' : 'drones',
              description: request.includes('horse') ? 'one horse' : 'three flying drones',
              action: 'moving',
              position: 'right',
            },
          ],
        }),
      );

      const result = await new ImagePromptService(llm, {
        llm: { model: 'planner' },
      } as AppConfig).prepare(request);

      expect(result.scene.subjects.reduce((sum, subject) => sum + subject.count, 0)).toBe(total);
      expect(result.providerPrompts.agnes).toContain(agnesText);
    },
  );

  it.each([
    ['pixel art di un gatto', 'pixel_art'],
    ['acquerello di Venezia', 'watercolor'],
    ['dipinto ad olio di una foresta', 'oil_painting'],
    ['render 3D di un robot', 'three_d'],
  ] as const)(
    'honors explicit medium wording before an inferred realistic profile: %s',
    (request, medium) => {
      expect(inferImageMedium(request, 'realistic')).toBe(medium);
    },
  );

  it.each([
    ['topless adult woman', 'explicit'],
    ['donna adulta senza vestiti', 'explicit'],
    ['due uomini nudi', 'explicit'],
    ['due persone senza veli', 'explicit'],
    ['una donna adulta spogliata', 'explicit'],
    ['fellatio tra due adulti', 'explicit'],
    ['penetrazione tra adulti', 'explicit'],
    ['scena anale tra adulti', 'explicit'],
    ['orgia di adulti', 'explicit'],
    ['erezione visibile', 'explicit'],
    ['ritratto BDSM di due adulti', 'explicit'],
    ['donna adulta in lingerie', 'suggestive'],
    ['sensual bikini portrait', 'suggestive'],
    ['adult mechanic in a workshop', 'safe'],
  ] as const)('classifies image rating conservatively: %s', (request, rating) => {
    expect(inferImageContentRating(request)).toBe(rating);
  });

  it('keeps inferred lingerie content suggestive instead of forcing it explicit', async () => {
    const { llm } = promptLlm(scene({ medium: 'anime', contentRating: 'suggestive' }));

    const result = await new ImagePromptService(llm, {
      llm: { model: 'planner' },
    } as AppConfig).prepare('ritratto di una donna adulta in lingerie');

    expect(result.profile).toBe('nsfw');
    expect(result.rating).toBe('suggestive');
    expect(result.expectsPeople).toBe(true);
  });

  it('marks an adult-rated object-only scene as not expecting people', async () => {
    const { llm } = promptLlm(
      scene({
        contentRating: 'explicit',
        subjects: [
          {
            count: 1,
            kind: 'graffiti drawing',
            description: 'explicit anatomical graffiti on concrete',
            action: '',
            position: 'center',
          },
        ],
      }),
    );

    const result = await new ImagePromptService(llm, {
      llm: { model: 'planner' },
    } as AppConfig).prepare('adult graffiti drawing of a penis on a concrete wall');

    expect(result.rating).toBe('explicit');
    expect(result.expectsPeople).toBe(false);
  });

  it.each([
    ['nurse in lingerie', 'nurse', 'a visibly mature nurse in lingerie', 'suggestive'],
    ['explicit astronaut portrait', 'astronaut', 'a mature astronaut', 'explicit'],
    ['sensual fantasy wizard', 'wizard', 'a mature fantasy wizard', 'suggestive'],
  ] as const)(
    'conservatively requires adult verification for semantic person type %s',
    async (request, kind, description, contentRating) => {
      const { llm } = promptLlm(
        scene({
          contentRating,
          subjects: [
            {
              count: 1,
              kind,
              description,
              action: 'posing',
              position: 'center',
            },
          ],
        }),
      );

      const result = await new ImagePromptService(llm, {
        llm: { model: 'planner' },
      } as AppConfig).prepare(request);

      expect(result.expectsPeople).toBe(true);
    },
  );

  it('does not sabotage a requested logo with provider negatives', async () => {
    const { llm } = promptLlm(
      scene({
        objective: 'A clean geometric fox logo',
        subjects: [
          {
            count: 1,
            kind: 'fox emblem',
            description: 'minimal geometric orange fox emblem',
            action: '',
            position: 'center',
          },
        ],
        mustInclude: ['geometric fox logo'],
        mustAvoid: ['photograph'],
      }),
    );

    const result = await new ImagePromptService(llm, {
      llm: { model: 'planner' },
    } as AppConfig).prepare('crea un logo geometrico con una volpe arancione');

    expect(result.providerPrompts.agnes).not.toMatch(/Exclude:[^.]*\blogo\b/i);
    expect(result.negativePrompt).not.toMatch(/(?:^|,\s*)logo(?:,|$)/i);
  });

  it('does not misclassify a person as scenery when their description mentions a landscape', async () => {
    const { llm } = promptLlm(
      scene({
        subjects: [
          {
            count: 1,
            kind: 'adult woman',
            description: 'adult woman standing before a mountain landscape',
            action: 'posing',
            position: 'center',
          },
        ],
      }),
    );

    const result = await new ImagePromptService(llm, {
      llm: { model: 'planner' },
    } as AppConfig).prepare('una donna adulta davanti a un paesaggio montano');

    expect(result.providerPrompts.agnes).toContain('exactly one main subject');
    expect(result.providerPrompts.agnes).not.toContain('do not invent a foreground person');
    expect(result.providerPrompts.pony).toContain('1girl');
  });

  it('routes a detail-dense single anime subject to Agnes instead of wasting a Pony retry', async () => {
    const { llm } = promptLlm(
      scene({
        medium: 'anime',
        subjects: [
          {
            count: 1,
            kind: 'adult woman astronaut',
            description: 'short purple hair and a white spacesuit',
            action: 'holding a transparent helmet',
            position: 'center',
          },
        ],
        importantDetails: ['Mars terrain', 'sunset sky', 'background rover'],
        mustInclude: ['purple hair', 'white suit', 'red chest patch', 'helmet under arm'],
      }),
    );

    const result = await new ImagePromptService(llm, {
      llm: { model: 'planner' },
    } as AppConfig).prepare('anime astronauta adulta su Marte con molti dettagli');

    expect(result.preferredProvider).toBe('agnes');
  });

  it('keeps a focused single-character anime concept on Pony despite repeated soft details', async () => {
    const { llm } = promptLlm(
      scene({
        medium: 'anime',
        subjects: [
          {
            count: 1,
            kind: 'adult woman warrior',
            description: 'fiery red hair and matte black armor',
            action: 'posing confidently',
            position: 'center',
          },
        ],
        importantDetails: [
          'fiery red hair',
          'matte black texture',
          'confident expression',
          'clean background',
        ],
        mustInclude: ['red hair', 'black armor', 'night blue background'],
        setting: 'Simple dark night blue background',
      }),
    );

    const result = await new ImagePromptService(llm, {
      llm: { model: 'planner' },
    } as AppConfig).prepare(
      'anime quadrata di una guerriera adulta dai capelli rossi e armatura nera, sfondo blu',
    );

    expect(result.preferredProvider).toBe('pony');
    expect(result.providerPrompts.pony).toContain('(simple background:1.3)');
    expect(result.providerPrompts.pony).toContain('(dark blue background:1.3)');
    expect(result.providerPrompts.pony).toContain('(upper body:1.35)');
    expect(result.providerPrompts.pony).toContain('vivid red hair');
    expect(result.providerPrompts.pony).not.toContain('fiery red hair');
    expect(result.negativePrompt).toContain('sky');
    expect(result.negativePrompt).toContain('detailed background');
    expect(result.negativePrompt).toContain('full body');
    expect(result.negativePrompt).toContain('sword');
  });

  it('splits coordinated exclusions into clean provider-negative terms', async () => {
    const { llm } = promptLlm(scene({ medium: 'anime' }));

    const result = await new ImagePromptService(llm, {
      llm: { model: 'planner' },
    } as AppConfig).prepare('ritratto anime di una donna adulta, nessun testo e nessun logo');

    expect(result.negativePrompt).toContain('readable text');
    expect(result.negativePrompt).toContain('logo');
    expect(result.negativePrompt).not.toContain('testo e nessun logo');
  });
});
