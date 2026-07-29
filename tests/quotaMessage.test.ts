import { describe, expect, it } from 'vitest';
import { formatQuotaRetry } from '../src/telegram/quotaMessage.js';

describe('formatQuotaRetry', () => {
  const now = new Date('2026-07-28T10:34:20.000Z');

  it('renders hourly limits as remaining minutes and reset time', () => {
    expect(
      formatQuotaRetry({ reason: 'conversation_hourly', retryAfterSeconds: 1_540 }, 'italian', now),
    ).toBe('tra 26 min (reset alle 13:00)');
  });

  it('renders daily limits as the Rome reset time', () => {
    expect(
      formatQuotaRetry({ reason: 'conversation_daily', retryAfterSeconds: 41_140 }, 'italian', now),
    ).toBe('al reset giornaliero delle 00:00');
  });

  it('never renders a zero-second retry when timing is unavailable', () => {
    expect(formatQuotaRetry({ reason: 'conversation_daily' }, 'italian', now)).toBe(
      'al prossimo reset',
    );
  });
});
