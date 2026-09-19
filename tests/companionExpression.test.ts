import { describe, expect, it } from 'vitest';
import {
  conversationContractPrompt,
  createConversationContract,
  operationalFailureMessage,
  renderResultEnvelope,
} from '../src/companion/expression/index.js';

describe('common companion expression', () => {
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
