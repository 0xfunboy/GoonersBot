import type { Api } from 'grammy';
import { z } from 'zod';
import type {
  IntegrationAdapter,
  IntegrationConnection,
  IntegrationRequest,
  IntegrationResult,
} from './types.js';

const textSchema = z.object({ text: z.string().trim().min(1).max(4000) }).strict();

/** Adapter for the actual configured bot, not an imaginary user account or personal Telegram session. */
export class TelegramConnector implements IntegrationAdapter {
  readonly id = 'telegram';
  readonly operations = [
    {
      id: 'chat.read',
      effect: 'read',
      description: 'Read metadata of an explicitly authorized Telegram conversation.',
    },
    { id: 'message.draft', effect: 'draft', description: 'Prepare a message without sending it.' },
    {
      id: 'message.send',
      effect: 'send',
      description:
        'Send a plain-text message to the exact delegated conversation and topic, with Telegram receipt.',
    },
  ] as const;

  constructor(private readonly api: Pick<Api, 'getChat' | 'sendMessage'>) {}

  accepts(connection: Pick<IntegrationConnection, 'accountId' | 'credentialRef'>): boolean {
    return (
      connection.accountId === 'configured-bot' &&
      connection.credentialRef.kind === 'secret_store' &&
      connection.credentialRef.provider === 'environment' &&
      connection.credentialRef.secretId === 'TELEGRAM_BOT_TOKEN'
    );
  }

  async execute(
    connection: IntegrationConnection,
    request: IntegrationRequest,
    signal?: AbortSignal,
  ): Promise<IntegrationResult> {
    if (!this.accepts(connection)) throw new Error('Configured bot connection required');
    const recipient = parseTelegramRecipient(request.recipient);
    if (request.resource !== `chat:${recipient.chatId}`)
      throw new Error('Resource/recipient mismatch');
    signal?.throwIfAborted();
    if (request.operation === 'chat.read') {
      z.object({}).strict().parse(request.input);
      const chat = await this.api.getChat(
        recipient.chatId,
        signal as Parameters<Api['getChat']>[1],
      );
      return {
        summary: 'Telegram conversation metadata verified.',
        verified: true,
        data: {
          id: chat.id,
          type: chat.type,
          title: 'title' in chat ? chat.title : undefined,
          username: 'username' in chat ? chat.username : undefined,
        },
      };
    }
    const { text } = textSchema.parse(request.input);
    if (request.operation === 'message.draft')
      return {
        summary: text,
        verified: true,
        data: { text, recipient: request.recipient, sent: false },
      };
    if (request.operation !== 'message.send') throw new Error('Unsupported Telegram operation');
    const sent = await this.api.sendMessage(
      recipient.chatId,
      text,
      {
        ...(recipient.threadId ? { message_thread_id: recipient.threadId } : {}),
        link_preview_options: { is_disabled: true },
      },
      signal as Parameters<Api['sendMessage']>[3],
    );
    return {
      summary: 'Message delivered to the authorized Telegram conversation.',
      verified: true,
      receipt: {
        provider: 'telegram',
        externalId: `${sent.chat.id}:${sent.message_id}`,
        recipient: request.recipient,
        timestamp: new Date(sent.date * 1000).toISOString(),
      },
    };
  }
}

export function parseTelegramRecipient(value: string): { chatId: number; threadId?: number } {
  const match = /^telegram:(-?[1-9]\d*)(?::([1-9]\d*))?$/.exec(value);
  const chatId = Number(match?.[1]);
  const threadId = match?.[2] ? Number(match[2]) : undefined;
  if (
    !match ||
    !Number.isSafeInteger(chatId) ||
    (threadId !== undefined && !Number.isSafeInteger(threadId))
  )
    throw new Error('Recipient must contain an immutable numeric Telegram chat/topic ID');
  return { chatId, ...(threadId ? { threadId } : {}) };
}
