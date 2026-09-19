import { describe, expect, it, vi } from 'vitest';
import { deliverCompanionLink } from '../src/services/companionLinkTransport.js';

const input = {
  request: 'rehost',
  language: 'italian',
  person: { telegramId: 1, userHandle: '@one' },
  context: { chatId: 1, isGroup: false, messageId: 5 },
  recentMessages: [],
};
function fixture() {
  const effects = new Map<string, unknown>();
  const api = {
    getMe: vi.fn().mockResolvedValue({ id: 99, is_bot: true, first_name: 'bot' }),
    sendDocument: vi.fn().mockResolvedValue({
      message_id: 42,
      chat: { id: 1, type: 'private' },
      document: { file_id: 'file' },
    }),
    sendPhoto: vi.fn(),
  };
  const ctx = {
    task: { contract: { acceptedVersion: 1 } },
    signal: new AbortController().signal,
    effect: async (key: string, run: () => Promise<unknown>) => {
      if (effects.has(key)) {
        const receipt = effects.get(key);
        if (!receipt) throw new Error('unknown');
        return receipt;
      }
      effects.set(key, null);
      const result = await run();
      effects.set(key, result);
      return result;
    },
  };
  return { api, ctx };
}
describe('durable link-media transport adapter', () => {
  it('reuses each confirmed send after restart without another Telegram upload', async () => {
    const { api, ctx } = fixture();
    const service = {
      rehostUrl: async ({
        ctx: context,
      }: {
        ctx: { replyWithDocument: (file: string) => Promise<{ message_id: number }> };
      }) => {
        const sent = await context.replyWithDocument('file-id');
        return { handled: true, messageIds: [sent.message_id] };
      },
    };
    for (let attempt = 0; attempt < 2; attempt++)
      await deliverCompanionLink(
        api as never,
        service as never,
        input as never,
        'https://example.org/video',
        ctx as never,
        async () => {},
      );
    expect(api.sendDocument).toHaveBeenCalledTimes(1);
  });
  it('blocks all fallback sends after an ambiguous transport exception', async () => {
    const { api, ctx } = fixture();
    api.sendDocument.mockRejectedValueOnce(new Error('connection lost after upload'));
    const service = {
      rehostUrl: async ({
        ctx: context,
      }: {
        ctx: {
          replyWithDocument: (file: string) => Promise<unknown>;
          replyWithPhoto: (file: string) => Promise<unknown>;
        };
      }) => {
        await context.replyWithDocument('file-id').catch(() => undefined);
        await context.replyWithPhoto('file-id').catch(() => undefined);
        return { handled: false };
      },
    };
    await expect(
      deliverCompanionLink(
        api as never,
        service as never,
        input as never,
        'https://example.org/video',
        ctx as never,
        async () => {},
      ),
    ).rejects.toThrow('reconciliation');
    expect(api.sendPhoto).not.toHaveBeenCalled();
  });
});
