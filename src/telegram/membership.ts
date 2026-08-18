import type { Bot } from 'grammy';
import type { TelegramMembershipStatus } from '../domain/entities.js';
import type { Services } from '../services/index.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('telegram-membership');

export function normalizeTelegramMembershipStatus(status: string): TelegramMembershipStatus | null {
  switch (status) {
    case 'creator':
    case 'administrator':
      return 'administrator';
    case 'member':
    case 'restricted':
      return 'member';
    case 'left':
      return 'left';
    case 'kicked':
      return 'kicked';
    default:
      return null;
  }
}

/** Only authoritative Telegram errors are converted to absence; transient failures retain state. */
export function membershipStatusFromTelegramError(
  error: unknown,
): Extract<TelegramMembershipStatus, 'left' | 'kicked'> | null {
  const description =
    typeof error === 'object' && error !== null && 'description' in error
      ? String((error as { description?: unknown }).description ?? '')
      : error instanceof Error
        ? error.message
        : String(error);
  if (/bot was kicked|kicked from|user is deactivated/i.test(description)) return 'kicked';
  if (/chat not found|bot is not a member|user not found/i.test(description)) return 'left';
  return null;
}

async function persistMembership(params: {
  services: Services;
  chatId: number;
  chatName?: string;
  status: TelegramMembershipStatus;
  previousStatus?: TelegramMembershipStatus;
  source: 'my_chat_member' | 'startup_audit' | 'manual_cleanup';
  updateId?: number;
  audited?: boolean;
  occurredAt?: Date;
}): Promise<void> {
  const { services } = params;
  const env = services.config.env;
  await services.storage.chats.createIfNotExists(params.chatId, params.chatName, {
    language: env.DEFAULT_LANGUAGE,
    conversationTracker: env.CONVERSATION_TRACKER_DEFAULT_ENABLED,
    autoengage: env.AUTOENGAGE_DEFAULT_ENABLED,
    autopost: env.AUTOPOST_DEFAULT_ENABLED,
    nsfwMode: env.LLM_NSFW_DEFAULT_MODE,
  });
  await Promise.all([
    services.storage.chats.setTelegramMembership(params.chatId, params.status, {
      chatName: params.chatName,
      audited: params.audited,
      observedAt: params.occurredAt,
    }),
    services.storage.chatMembershipEvents.record({
      chatId: params.chatId,
      chatName: params.chatName,
      status: params.status,
      previousStatus: params.previousStatus,
      source: params.source,
      updateId: params.updateId,
      occurredAt: params.occurredAt,
    }),
  ]);
}

export async function auditApprovedChatMemberships(
  bot: Bot,
  services: Services,
  botId: number,
): Promise<void> {
  const approvedChatIds = services.access.list().chats.filter((chatId) => chatId < 0);
  for (const chatId of approvedChatIds) {
    const previousStatus = await services.storage.chats.getTelegramMembership(chatId);
    try {
      const member = await bot.api.getChatMember(chatId, botId);
      const status = normalizeTelegramMembershipStatus(member.status);
      if (!status) {
        log.warn(
          { chatId, telegramStatus: member.status },
          'unsupported Telegram membership state',
        );
        continue;
      }
      await persistMembership({
        services,
        chatId,
        status,
        previousStatus,
        source: 'startup_audit',
        audited: true,
      });
      log.info({ chatId, status }, 'approved chat membership audited');
    } catch (error) {
      const status = membershipStatusFromTelegramError(error);
      if (!status) {
        log.warn({ err: error, chatId }, 'membership audit failed transiently; state retained');
        continue;
      }
      await persistMembership({
        services,
        chatId,
        status,
        previousStatus,
        source: 'startup_audit',
        audited: true,
      });
      log.warn({ chatId, status }, 'approved chat is no longer reachable');
    }
  }
}

export async function persistMyChatMemberUpdate(
  services: Services,
  update: {
    updateId: number;
    chatId: number;
    chatName?: string;
    oldStatus: string;
    newStatus: string;
    occurredAt?: Date;
  },
): Promise<void> {
  const status = normalizeTelegramMembershipStatus(update.newStatus);
  const previousStatus = normalizeTelegramMembershipStatus(update.oldStatus) ?? undefined;
  if (!status) {
    log.warn(
      { chatId: update.chatId, telegramStatus: update.newStatus },
      'unsupported my_chat_member state',
    );
    return;
  }
  await persistMembership({
    services,
    chatId: update.chatId,
    chatName: update.chatName,
    status,
    previousStatus,
    source: 'my_chat_member',
    updateId: update.updateId,
    occurredAt: update.occurredAt,
  });
  log.info(
    {
      chatId: update.chatId,
      approved: services.access.isChatApproved(update.chatId),
      from: previousStatus ?? update.oldStatus,
      to: status,
    },
    'my_chat_member event persisted',
  );
}
