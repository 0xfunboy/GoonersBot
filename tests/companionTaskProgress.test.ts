import { describe, expect, it, vi } from 'vitest';
import {
  formatProgressBar,
  CompanionTaskProgressReporter,
} from '../src/companion/tasks/progress.js';

describe('formatProgressBar', () => {
  it('formats 0% correctly with width 10', () => {
    expect(formatProgressBar(0)).toBe('[░░░░░░░░░░] 0%');
  });

  it('formats 50% correctly', () => {
    expect(formatProgressBar(50)).toBe('[█████░░░░░] 50%');
  });

  it('formats 100% correctly', () => {
    expect(formatProgressBar(100)).toBe('[██████████] 100%');
  });

  it('clamps values below 0 and above 100', () => {
    expect(formatProgressBar(-10)).toBe('[░░░░░░░░░░] 0%');
    expect(formatProgressBar(150)).toBe('[██████████] 100%');
  });

  it('handles custom widths', () => {
    expect(formatProgressBar(50, 8)).toBe('[████░░░░] 50%');
    expect(formatProgressBar(100, 8)).toBe('[████████] 100%');
  });
});

describe('CompanionTaskProgressReporter', () => {
  it('updates progress message in-place and throttles rapid calls', async () => {
    const editMessageText = vi.fn().mockResolvedValue(true);
    const deleteMessage = vi.fn().mockResolvedValue(true);

    const reporter = new CompanionTaskProgressReporter(
      { editMessageText, deleteMessage } as never,
      {
        chatId: 12345,
        messageId: 999,
        language: 'italian',
      },
    );

    expect(reporter.messageId).toBe(999);

    // Initial update executes immediately
    await reporter.update(25, 'Analisi richiesta...');
    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(editMessageText).toHaveBeenCalledWith(
      12345,
      999,
      expect.stringContaining('[███░░░░░░░] 25% · Analisi richiesta...'),
    );

    // Rapid successive update is throttled
    await reporter.update(50, 'Download...');
    // Should still be 1 call synchronously until throttle flushes
    expect(editMessageText).toHaveBeenCalledTimes(1);
  });

  it('updates the progress message in-place on complete() without deletion', async () => {
    const editMessageText = vi.fn().mockResolvedValue(true);

    const reporter = new CompanionTaskProgressReporter(
      { editMessageText } as never,
      {
        chatId: 12345,
        messageId: 888,
        language: 'italian',
      },
    );

    await reporter.update(10, 'Inizio...');
    expect(editMessageText).toHaveBeenCalledTimes(1);

    await reporter.complete();
    expect(editMessageText).toHaveBeenCalledTimes(2);
    expect(editMessageText.mock.calls[1]?.[2]).toMatch(/completat/i);

    // Further updates after complete() are ignored
    await reporter.update(100, 'Ignored');
    expect(editMessageText).toHaveBeenCalledTimes(2);
  });

  it('updates the progress message in-place on fail() without deletion', async () => {
    const editMessageText = vi.fn().mockResolvedValue(true);

    const reporter = new CompanionTaskProgressReporter(
      { editMessageText } as never,
      {
        chatId: 54321,
        messageId: 777,
      },
    );

    await reporter.fail('Task cancelled');
    expect(editMessageText).toHaveBeenCalledWith(
      54321,
      777,
      expect.stringContaining('Task cancelled'),
    );
  });
});
