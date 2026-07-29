import { describe, expect, it, vi } from 'vitest';
import {
  assertMediaGenerationSafe,
  containsMinorMediaReference,
  MediaSafetyError,
} from '../src/safety/mediaSafety.js';
import { ImagePromptService } from '../src/services/imagePrompt.js';
import { VideoPromptService } from '../src/services/videoPrompt.js';

const config = { llm: { model: 'test' } } as never;

describe('media generation safety boundary', () => {
  it.each([
    'ritratto di un bambino',
    'video con due minorenni',
    'ragazzina di 16 anni',
    'a 17-year-old character',
    'schoolgirl portrait',
    'under 18 model',
    'una liceale in uniforme',
    'studentessa delle superiori',
    'una sedicenne',
    'una diciassettenne',
    'sixteen-year-old portrait',
    'seventeen year old character',
    'ragazza di sedici anni',
    'l\u200Boli character',
  ])('detects Italian/English minor wording: %s', (prompt) => {
    expect(containsMinorMediaReference(prompt)).toBe(true);
    expect(() => assertMediaGenerationSafe(prompt)).toThrow(MediaSafetyError);
  });

  it.each([
    'due donne adulte che ballano',
    'two adult men hiking',
    'panorama delle Dolomiti al tramonto',
    'due cani che corrono',
  ])('does not flag adult/non-human requests: %s', (prompt) => {
    expect(containsMinorMediaReference(prompt)).toBe(false);
  });

  it('discards an unsafe image draft invented by the compiler and uses the safe fallback', async () => {
    const llm = {
      jsonCompletion: vi.fn().mockResolvedValue({
        objective: 'An unsafe child portrait',
        medium: 'photo',
        contentRating: 'safe',
        aspectRatio: '1:1',
        subjects: [
          {
            count: 1,
            kind: 'child',
            description: 'young child with a detailed face',
            action: 'posing',
            position: 'center frame',
          },
        ],
        interaction: '',
        composition: {
          shot: 'portrait',
          angle: 'eye level',
          lens: '85mm',
          focus: 'child face',
        },
        setting: 'fantasy landscape',
        lighting: 'soft light',
        palette: 'warm colors',
        mood: 'calm',
        importantDetails: [],
        mustInclude: [],
        mustAvoid: [],
        exactText: null,
      }),
    };
    const prepared = await new ImagePromptService(llm as never, config).prepare(
      'un ritratto fantasy di un adulto',
    );
    expect(prepared.usedFallback).toBe(true);
    expect(prepared.providerPrompts.agnes).not.toMatch(/\bchild\b/i);
    expect(prepared.providerPrompts.pony).not.toMatch(/\bchild\b/i);
  });

  it('blocks an unsafe structured video draft invented by the compiler', async () => {
    const llm = {
      jsonCompletion: vi.fn().mockResolvedValue({
        title: 'Clip',
        coreIntent: 'un bambino corre',
        prompt: 'cinematic street',
        negativePrompt: '',
        continuityNotes: [],
        shots: [{ beat: 'start', action: 'runs', camera: 'tracking' }],
      }),
    };
    await expect(
      new VideoPromptService(llm as never, config).prepare('un adulto corre in strada'),
    ).rejects.toBeInstanceOf(MediaSafetyError);
  });

  it('does not force portrait/face tags onto a landscape fallback', async () => {
    const llm = { jsonCompletion: vi.fn().mockRejectedValue(new Error('offline')) };
    const prepared = await new ImagePromptService(llm as never, config).prepare(
      'panorama delle Dolomiti al tramonto',
    );
    expect(prepared.prompt).not.toMatch(/\bsolo\b|detailed face|sharp eyes/i);
    expect(prepared.prompt).toContain('Dolomiti');
  });

  it('does not turn a person in a forest into scenery when planning falls back', async () => {
    const llm = { jsonCompletion: vi.fn().mockRejectedValue(new Error('offline')) };
    const prepared = await new ImagePromptService(llm as never, config).prepare(
      'una donna adulta con capelli rossi in una foresta',
    );

    expect(prepared.scene.subjects[0]?.kind).toBe('adult woman');
    expect(prepared.providerPrompts.agnes).toContain('exactly one main subject');
    expect(prepared.providerPrompts.agnes).not.toContain('do not invent a foreground person');
  });

  it.each([
    ['one woman standing beside one robot', ['adult woman', 'robot']],
    ['one woman standing beside one horse', ['adult woman', 'horse']],
  ])('keeps mixed fallback subjects distinct for %s', async (request, kinds) => {
    const llm = { jsonCompletion: vi.fn().mockRejectedValue(new Error('offline')) };
    const prepared = await new ImagePromptService(llm as never, config).prepare(request);

    expect(prepared.scene.subjects.map((subject) => subject.kind)).toEqual(kinds);
    expect(prepared.scene.requestedSubjectCount).toBe(2);
    expect(prepared.providerPrompts.agnes).toContain('exactly one adult woman');
    expect(prepared.providerPrompts.agnes).toContain(`exactly one ${kinds[1]}`);
    expect(prepared.providerPrompts.pony).toContain('1girl');
  });

  it.each([
    'una donna adulta con orecchie da gatto',
    'one adult woman wearing a robot T-shirt',
    'an adult man holding a toy robot',
    'una donna adulta con un cavallo stampato sulla maglietta',
  ])(
    'does not promote decorative motifs or toys to main fallback subjects: %s',
    async (request) => {
      const llm = { jsonCompletion: vi.fn().mockRejectedValue(new Error('offline')) };
      const prepared = await new ImagePromptService(llm as never, config).prepare(request);

      expect(prepared.scene.subjects).toHaveLength(1);
      expect(prepared.scene.subjects[0]?.kind).toMatch(/^adult (?:woman|man)$/);
      expect(prepared.scene.subjects[0]?.count).toBe(1);
    },
  );

  it.each([
    ['due donne adulte che ballano', '2women'],
    ['due uomini adulti che giocano', '2men'],
    ['due cani che corrono', '2dogs'],
    ['due gatti sul divano', '2cats'],
  ])('preserves multi-subject composition for %s', async (request, expected) => {
    const llm = { jsonCompletion: vi.fn().mockRejectedValue(new Error('offline')) };
    const prepared = await new ImagePromptService(llm as never, config).prepare(request);
    expect(prepared.prompt).toContain(expected);
    if (expected !== '2women') expect(prepared.prompt).not.toContain('1woman, 1man');
  });
});
