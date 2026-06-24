import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/index.js';
import type { LLMProvider } from '../src/providers/llm/types.js';
import { ImagePromptService } from '../src/services/imagePrompt.js';

describe('ImagePromptService', () => {
  it('uses the default prompt model for an Italian explicit request', async () => {
    const chatCompletion = vi.fn(async () => ({
      text: 'score_9, score_8_up, rating_explicit, adult woman, explicit oral sex, anime illustration',
      usage: { estimated: true },
      model: 'nsfw-llm',
    }));
    const llm = { chatCompletion } as unknown as LLMProvider;
    const config = {
      llm: { model: 'default-llm', nsfwModel: 'nsfw-llm' },
    } as AppConfig;
    const service = new ImagePromptService(llm, config);

    const result = await service.prepare('una donna adulta con un cazzo in bocca');

    expect(result.profile).toBe('nsfw');
    expect(result.model).toBe('default-llm');
    expect(result.prompt).toContain('rating_explicit');
    expect(chatCompletion).toHaveBeenCalledWith(expect.objectContaining({ model: 'default-llm' }));
  });

  it('honors a group-plan model override', async () => {
    const chatCompletion = vi.fn(async () => ({
      text: 'adult woman, neon city, anime illustration',
      usage: { estimated: true },
      model: 'economy-model',
    }));
    const service = new ImagePromptService(
      { chatCompletion } as unknown as LLMProvider,
      { llm: { model: 'premium-model' } } as AppConfig,
    );

    await service.prepare('una donna adulta in citta', { model: 'economy-model' });
    expect(chatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'economy-model' }),
    );
  });

  it('keeps Italian explicit acts meaningful when the prompt LLM fails', async () => {
    const llm = {
      chatCompletion: vi.fn(async () => {
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
    expect(result.prompt).toContain('penis in mouth, oral sex, blowjob');
  });

  it('adds explicit two-subject framing to a fallback prompt', async () => {
    const llm = {
      chatCompletion: vi.fn(async () => {
        throw new Error('backend unavailable');
      }),
    } as unknown as LLMProvider;
    const config = {
      llm: { model: 'default-llm', nsfwModel: 'nsfw-llm' },
    } as AppConfig;

    const result = await new ImagePromptService(llm, config).prepare(
      'soggetto 1 sulle spalle del soggetto 2, entrambi adulti, strada di notte',
    );

    expect(result.prompt).toContain('2people, two adults');
    expect(result.prompt).toContain('both subjects visible');
  });

  it('keeps a named second subject when the prompt model falls back', async () => {
    const llm = {
      chatCompletion: vi.fn(async () => {
        throw new Error('backend unavailable');
      }),
    } as unknown as LLMProvider;
    const config = {
      llm: { model: 'default-llm', nsfwModel: 'nsfw-llm' },
    } as AppConfig;

    const result = await new ImagePromptService(llm, config).prepare(
      'woman laying a brown egg over Daniele',
    );

    expect(result.prompt).toContain('1girl, 1boy');
    expect(result.prompt).toContain('adult man');
  });
});
