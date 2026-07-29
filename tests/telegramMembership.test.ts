import { describe, expect, it } from 'vitest';
import {
  membershipStatusFromTelegramError,
  normalizeTelegramMembershipStatus,
} from '../src/telegram/membership.js';

describe('Telegram membership normalization', () => {
  it.each([
    ['creator', 'administrator'],
    ['administrator', 'administrator'],
    ['member', 'member'],
    ['restricted', 'member'],
    ['left', 'left'],
    ['kicked', 'kicked'],
  ])('normalizes %s as %s', (input, expected) => {
    expect(normalizeTelegramMembershipStatus(input)).toBe(expected);
  });

  it('fails closed on unsupported future states', () => {
    expect(normalizeTelegramMembershipStatus('unknown')).toBeNull();
  });

  it('distinguishes authoritative absence from transient errors', () => {
    expect(membershipStatusFromTelegramError(new Error('Forbidden: bot was kicked'))).toBe(
      'kicked',
    );
    expect(membershipStatusFromTelegramError(new Error('Bad Request: chat not found'))).toBe(
      'left',
    );
    expect(membershipStatusFromTelegramError(new Error('fetch failed: timeout'))).toBeNull();
  });
});
