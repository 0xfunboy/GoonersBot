import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatProgressBar, ImageProgressReporter } from '../src/telegram/imageProgress.js';
import { formatPersonMention } from '../src/utils/handles.js';

describe('Image Progress & Playground Personalization', () => {
  describe('formatProgressBar', () => {
    it('formats 0%', () => {
      expect(formatProgressBar(0)).toBe('[░░░░░░░░░░] 0%');
    });

    it('formats 40%', () => {
      expect(formatProgressBar(40)).toBe('[████░░░░░░] 40%');
    });

    it('formats 100%', () => {
      expect(formatProgressBar(100)).toBe('[██████████] 100%');
    });

    it('clamps below 0 and above 100', () => {
      expect(formatProgressBar(-10)).toBe('[░░░░░░░░░░] 0%');
      expect(formatProgressBar(150)).toBe('[██████████] 100%');
    });
  });

  describe('ImageProgressReporter', () => {
    it('starts with monospace prompt and deletes upon completion', async () => {
      const mockSendMessage = vi.fn().mockResolvedValue({ message_id: 1234 });
      const mockEditMessageText = vi.fn().mockResolvedValue(true);
      const mockDeleteMessage = vi.fn().mockResolvedValue(true);

      const mockApi = {
        sendMessage: mockSendMessage,
        editMessageText: mockEditMessageText,
        deleteMessage: mockDeleteMessage,
      } as any;

      const reporter = new ImageProgressReporter({
        api: mockApi,
        chatId: 999,
        replyToMessageId: 42,
        initialPrompt: 'a cute anime girl in a garden',
      });

      await reporter.start('a cute anime girl in a garden');
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      const callArgs = mockSendMessage.mock.calls[0];
      expect(callArgs[0]).toBe(999);
      expect(callArgs[1]).toContain('<code>a cute anime girl in a garden</code>');
      expect(callArgs[1]).toContain('[░░░░░░░░░░] 0%');
      expect(callArgs[2].parse_mode).toBe('HTML');
      expect(callArgs[2].reply_parameters).toEqual({ message_id: 42 });

      await reporter.delete();
      expect(mockDeleteMessage).toHaveBeenCalledWith(999, 1234);
    });
  });

  describe('formatPersonMention', () => {
    it('returns @username when user has a handle', () => {
      expect(formatPersonMention({ userHandle: '@funboy', firstName: 'Johnny' })).toBe('@funboy');
    });

    it('returns firstName when handle is fallback @id12345', () => {
      expect(formatPersonMention({ userHandle: '@id12345', firstName: 'Johnny' })).toBe('Johnny');
    });

    it('returns fallback handle when no firstName is available', () => {
      expect(formatPersonMention({ userHandle: '@id12345' })).toBe('@id12345');
    });
  });
});
