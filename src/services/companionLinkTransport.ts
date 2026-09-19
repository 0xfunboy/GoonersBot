import { Context, type Api } from 'grammy';
import { createHash } from 'node:crypto';
import type { AgentRuntimeInput } from './agentRuntime.js';
import type { LinkMediaService, LinkMediaResult } from './linkMedia.js';
import type { TaskExecutionContext } from '../companion/tasks/service.js';

const sends = new Set([
  'sendMessage',
  'sendPhoto',
  'sendVideo',
  'sendAnimation',
  'sendAudio',
  'sendVoice',
  'sendDocument',
  'sendMediaGroup',
]);

/** Keep the established downloader/normalizer, replacing only transport ownership with receipts. */
export async function deliverCompanionLink(
  api: Api,
  service: LinkMediaService,
  input: AgentRuntimeInput,
  url: string,
  task: TaskExecutionContext,
  authorize: () => Promise<void>,
): Promise<LinkMediaResult> {
  const identity = createHash('sha256').update(url).digest('hex').slice(0, 20);
  let sequence = 0;
  let uncertain = false;
  const guardedApi = new Proxy(api, {
    get(target, property, receiver) {
      const original = Reflect.get(target, property, receiver) as unknown;
      if (typeof original !== 'function') return original;
      if (!sends.has(String(property))) return original.bind(target);
      return async (...args: unknown[]) => {
        if (uncertain)
          throw new Error('A previous transport outcome is unknown; no fallback send is allowed');
        const key = `link:v${task.task.contract.acceptedVersion}:${identity}:${String(property)}:${sequence++}`;
        try {
          return await task.effect(key, async () => {
            await authorize();
            task.signal.throwIfAborted();
            return (await original.apply(target, args)) as unknown;
          });
        } catch (error) {
          uncertain = true;
          throw error;
        }
      };
    },
  });
  await authorize();
  const bot = await api.getMe();
  const context = new Context(
    {
      update_id: 0,
      message: {
        message_id: input.context.messageId ?? 1,
        date: Math.floor(Date.now() / 1000),
        chat: input.context.isGroup
          ? {
              id: input.context.chatId,
              type: 'supergroup',
              title: input.context.chatName ?? 'chat',
            }
          : {
              id: input.context.chatId,
              type: 'private',
              first_name: input.person.firstName ?? 'user',
            },
        from: {
          id: input.person.telegramId,
          is_bot: false,
          first_name: input.person.firstName ?? 'user',
        },
        ...(input.context.threadId !== undefined
          ? { message_thread_id: input.context.threadId }
          : {}),
        text: url,
      },
    },
    guardedApi,
    bot,
  );
  const result = await service.rehostUrl({
    ctx: context,
    context: input.context,
    url,
    addressed: true,
    quotaBypass: input.quotaBypass,
    signal: task.signal,
  });
  if (uncertain) throw new Error('Link delivery outcome requires reconciliation');
  return result;
}
