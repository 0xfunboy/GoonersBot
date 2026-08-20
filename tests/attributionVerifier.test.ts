import { describe, expect, it, vi } from 'vitest';
import { AttributionVerifier, shouldVerifyAttribution } from '../src/brain/attributionVerifier.js';
import type { LLMProvider } from '../src/providers/llm/types.js';

describe('AttributionVerifier', () => {
  it('flags a cross-person biography and returns the narrow model repair', async () => {
    const jsonCompletion = vi.fn().mockResolvedValue({
      safe: false,
      issues: [
        {
          subject: '@daniele',
          claim: 'Daniele è il tizio del trattore',
          reason: 'style_as_biography',
        },
      ],
      rewrite: 'Berry, hai incrociato due persone diverse: Daniele non è quello del trattore.',
    });
    const verifier = new AttributionVerifier({
      capabilities: { chat: true },
      jsonCompletion,
    } as unknown as LLMProvider);
    const result = await verifier.verify({
      candidate: 'Daniele, scendi dal trattore e mandaci i video.',
      currentHandle: '@berry',
      currentMessage: '@daniele manda uno dei tuoi video',
      replyToHandle: '@bot',
      recentMessages: [
        { handle: '@berry', text: 'Daniele è @ilrinnegato' },
        { handle: '@berry', text: 'Piero è quello che manda i video del trattore' },
      ],
      socialContext:
        '- MEMBER @daniele: communication_style:monologhi_agricoltura=parla spesso di agricoltura',
      language: 'italian',
    });
    expect(result).toMatchObject({ safe: false, rewrite: expect.stringContaining('non è') });
    expect(jsonCompletion).toHaveBeenCalledOnce();
  });

  it('requires a check for multi-person context and identity assertions, not ordinary factual prose', () => {
    expect(
      shouldVerifyAttribution({
        candidate: 'Il soffritto va fatto a fuoco basso.',
        currentHandle: '@berry',
        currentMessage: 'come faccio il soffritto?',
        socialContext: '- MEMBER @berry: preference:cooking=soffritto',
      }),
    ).toBe(false);
    expect(
      shouldVerifyAttribution({
        candidate: 'Johnny confronta le offerte in Excel.',
        currentHandle: '@berry',
        currentMessage: 'mi hai preso per Johnny?',
        socialContext: '- MEMBER @berry\n- MEMBER @johnny',
      }),
    ).toBe(true);
    expect(
      shouldVerifyAttribution({
        candidate: 'Miguel è sardo.',
        currentHandle: '@miguel',
        currentMessage: 'ciao',
        socialContext: '- MEMBER @miguel',
      }),
    ).toBe(true);
  });
});
