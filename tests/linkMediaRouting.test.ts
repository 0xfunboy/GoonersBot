import { describe, expect, it } from 'vitest';
import { Localizer } from '../src/config/index.js';
import {
  formatMediaDuration,
  linkMediaHandlerErrorResult,
  shouldStopAfterDeterministicLinkMedia,
} from '../src/telegram/handlers/message.js';

describe('deterministic link-media conversation routing', () => {
  it('formats the known duration and cap for a short deterministic notice', () => {
    expect(formatMediaDuration(1_050)).toBe('17:30');
    expect(formatMediaDuration(300)).toBe('5:00');
    expect(formatMediaDuration(3_661)).toBe('1:01:01');
    expect(
      new Localizer('italian').t(
        'media_rehost_duration_exceeded',
        { duration: '17:30', limit: '5:00' },
        'italian',
      ),
    ).toBe('Rehost disabilitato: video da 17:30, limite 5:00.');
  });

  it('stays silent after a passive rehost when autoengage is disabled', () => {
    expect(
      shouldStopAfterDeterministicLinkMedia({
        handled: true,
        failedUrlCount: 0,
        addressed: false,
        autoengageEnabled: false,
      }),
    ).toBe(true);
  });

  it('allows a later conversational comment after a successful passive rehost', () => {
    expect(
      shouldStopAfterDeterministicLinkMedia({
        handled: true,
        failedUrlCount: 0,
        addressed: false,
        autoengageEnabled: true,
      }),
    ).toBe(false);
  });

  it('never sends a failed deterministic download through the agent as a fake artifact', () => {
    expect(
      shouldStopAfterDeterministicLinkMedia({
        handled: false,
        failedUrlCount: 1,
        addressed: true,
        autoengageEnabled: true,
      }),
    ).toBe(true);
  });

  it('does not consume ordinary unsupported links', () => {
    expect(
      shouldStopAfterDeterministicLinkMedia({
        handled: false,
        failedUrlCount: 0,
        addressed: true,
        autoengageEnabled: false,
      }),
    ).toBe(false);
  });

  it('fails closed when the handler throws before it can report attempted URLs', () => {
    const detectedUrls = [
      new URL('https://www.instagram.com/reel/example/'),
      new URL('https://x.com/example/status/123'),
    ];
    const result = linkMediaHandlerErrorResult(detectedUrls);

    expect(result).toMatchObject({
      handled: false,
      reason: 'handler_error',
      attemptedUrls: detectedUrls.map(String),
      failedUrls: detectedUrls.map(String),
    });
    expect(
      shouldStopAfterDeterministicLinkMedia({
        handled: result.handled,
        // Exercise the defensive route independently of the populated arrays: even a malformed
        // handler-error result must not leak a detected URL into addressed/autoengage inference.
        failedUrlCount: 0,
        detectedUrlCount: detectedUrls.length,
        reason: result.reason,
        addressed: true,
        autoengageEnabled: true,
      }),
    ).toBe(true);
  });

  it('does not turn a handler error without any detected URL into a conversational stop', () => {
    const result = linkMediaHandlerErrorResult([]);

    expect(result.attemptedUrls).toBeUndefined();
    expect(result.failedUrls).toBeUndefined();
    expect(
      shouldStopAfterDeterministicLinkMedia({
        handled: result.handled,
        failedUrlCount: 0,
        detectedUrlCount: 0,
        reason: result.reason,
        addressed: true,
        autoengageEnabled: true,
      }),
    ).toBe(false);
  });
});
