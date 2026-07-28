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

  it('blocks an unsafe image prompt invented by the compiler instead of using it or a fallback', async () => {
    const llm = {
      chatCompletion: vi.fn().mockResolvedValue({
        text: 'child, portrait, detailed face',
        model: 'test',
        usage: { estimated: true },
      }),
    };
    await expect(
      new ImagePromptService(llm as never, config).prepare('un ritratto fantasy di un adulto'),
    ).rejects.toBeInstanceOf(MediaSafetyError);
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
    const llm = { chatCompletion: vi.fn().mockRejectedValue(new Error('offline')) };
    const prepared = await new ImagePromptService(llm as never, config).prepare(
      'panorama delle Dolomiti al tramonto',
    );
    expect(prepared.prompt).not.toMatch(/\bsolo\b|detailed face|sharp eyes/i);
    expect(prepared.prompt).toContain('Dolomiti');
  });

  it.each([
    ['due donne adulte che ballano', '2women'],
    ['due uomini adulti che giocano', '2men'],
    ['due cani che corrono', '2dogs'],
    ['due gatti sul divano', '2cats'],
  ])('preserves multi-subject composition for %s', async (request, expected) => {
    const llm = { chatCompletion: vi.fn().mockRejectedValue(new Error('offline')) };
    const prepared = await new ImagePromptService(llm as never, config).prepare(request);
    expect(prepared.prompt).toContain(expected);
    if (expected !== '2women') expect(prepared.prompt).not.toContain('1woman, 1man');
  });
});
