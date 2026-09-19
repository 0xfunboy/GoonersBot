import { describe, expect, it } from 'vitest';
import {
  conversationContractPrompt,
  createConversationContract,
  guardConversationalPromises,
  operationalFailureMessage,
  renderResultEnvelope,
} from '../src/companion/expression/index.js';

describe('common companion expression', () => {
  it('repairs the observed false PDF retry promise without inventing another action', () => {
    const result = guardConversationalPromises(
      'Hai ragione, è uscito completamente bianco. Te lo rifaccio per bene.',
    );
    expect(result).toEqual({
      text: 'Hai ragione, è uscito completamente bianco.',
      removedSentences: 1,
    });
  });

  it.each([
    'Lo rigenero e te lo mando fra poco.',
    'Ti preparo un nuovo PDF.',
    'Adesso controllo la pagina e poi ti mando il report.',
    'Ti invierò il file corretto.',
    "I'll resend the document shortly.",
    'Te lo rehago ahora mismo.',
  ])('does not invent work after an unsupported commitment: %s', (text) => {
    const result = guardConversationalPromises(text);
    expect(result.removedSentences).toBe(1);
    expect(result.text).toBe('Non è partita una nuova elaborazione o un nuovo invio.');
  });

  it.each([
    'Ahah, questa me la sono meritata 😂',
    'Ti prometto che la battuta era migliore nella mia testa.',
    'Ti mando un abbraccio.',
    'Rimando la decisione a domani.',
    'Posso prepararti un PDF.',
    'Se vuoi, te lo rifaccio.',
    'Non te lo rimando senza conferma.',
    'I can resend the document if you want.',
    'Vuoi che te lo rifaccio?',
    '> Te lo rifaccio per bene.',
    'Grazie!\n\nMi fa piacere.',
  ])('preserves ordinary banter, offers, negatives and quotations: %s', (text) => {
    expect(guardConversationalPromises(text)).toEqual({ text, removedSentences: 0 });
  });

  it('gives the ordinary composer explicit absence of new receipts and accountability rules', () => {
    const prompt = conversationContractPrompt(createConversationContract(), {
      newWorkStarted: false,
    });
    expect(prompt).toContain('new work/retry/redelivery/schedule receipts = NONE');
    expect(prompt).toContain('Never blame the user, their links or their tone');
    expect(prompt).toContain('do not claim you inspected an artifact');
    expect(prompt).toContain('A request for a serious analysis takes precedence over banter');
  });

  it('keeps receipt-backed progress on its separate operational path', () => {
    const result = renderResultEnvelope({
      schemaVersion: 1,
      status: 'running',
      task: { id: 'real-task', version: 1 },
      nextEvent: {
        kind: 'task',
        receiptId: 'accepted-version-1',
        description: 'Ti mando il PDF quando è pronto.',
      },
    });
    expect(result).toContain('Me ne sto occupando.');
    expect(result).toContain('Ti mando il PDF quando è pronto.');
  });

  it('retains social floors and does not imply queued work without a durable task', () => {
    const contract = createConversationContract({
      language: 'english',
      socialContract: 'Affection must be received warmly.',
      roastCeiling: 0.2,
    });
    expect(conversationContractPrompt(contract)).toContain('Affection must be received warmly.');
    expect(renderResultEnvelope({ schemaVersion: 1, status: 'queued' }, contract)).toContain(
      'cannot confirm',
    );
    expect(
      renderResultEnvelope(
        { schemaVersion: 1, status: 'queued', task: { id: 'task', version: 1 } },
        contract,
      ),
    ).toContain('working on it');
  });

  it('preserves a real result and describes missing delivery without exposing internal diagnostics', () => {
    const result = renderResultEnvelope({
      schemaVersion: 1,
      status: 'partial',
      observations: ['Ho letto i due documenti: il secondo aggiorna la data di consegna.'],
      limitations: [
        {
          status: 'failed',
          error:
            'verification failed: missing required video artifact\n at /home/service/token.ts:123',
        },
      ],
      artifacts: [{ id: 'report', name: 'report.pdf', delivery: 'unknown' }],
    });
    expect(result).toContain('aggiorna la data');
    expect(result).toContain('Non ho conferma della consegna');
    expect(result).not.toMatch(/token.ts|verification failed|missing required/);
    expect(operationalFailureMessage({ status: 'timed_out' }, 'english')).toContain(
      'available time',
    );
  });
});
