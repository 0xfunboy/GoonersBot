import type { ChatQuotaDoc } from '../domain/entities.js';
import { emptyDailyCounters, emptyHourlyCounters } from '../storage/repositories/chatQuota.js';
import type { Storage } from '../storage/index.js';
import { QUOTA_PLANS, type QuotaPlan, type QuotaPlanId } from '../quota/plans.js';

export type QuotaResource = 'web_search' | 'page_scan' | 'news' | 'image' | 'media' | 'media_bytes';

export type QuotaDenyReason =
  | 'conversation_daily'
  | 'conversation_hourly'
  | 'passive_hourly'
  | 'user_cooldown'
  | 'chat_cooldown'
  | 'user_burst'
  | 'chat_burst'
  | QuotaResource
  | 'llm_tokens';

export interface QuotaDecision {
  allowed: boolean;
  reason?: QuotaDenyReason;
  retryAfterSeconds?: number;
  tokenReservation?: number;
}

export interface GroupQuotaReport {
  plan: QuotaPlan;
  daily: ChatQuotaDoc['daily'];
  hourly: ChatQuotaDoc['hourly'];
  dayKey: string;
  hourKey: string;
}

const TIME_ZONE = 'Europe/Rome';
const MAX_CAS_RETRIES = 12;

/**
 * Group-level operational quotas. A chat has one versioned Mongo document, so a single CAS update
 * can admit a request while updating its day/hour/minute windows and flood state together.
 */
export class GroupQuotaService {
  constructor(private readonly storage: Storage) {}

  async setPlan(chatId: number, plan: QuotaPlanId): Promise<GroupQuotaReport> {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
      const current = await this.storage.chatQuota.getOrCreate(chatId);
      const next = cloneQuota(current);
      normalizeWindows(next, new Date());
      next.plan = plan;
      next.version = current.version + 1;
      next.updatedAt = new Date();
      if (await this.storage.chatQuota.compareAndSet(next, current.version))
        return this.toReport(next);
    }
    throw new Error('chat quota plan update contention');
  }

  async getReport(chatId: number): Promise<GroupQuotaReport> {
    const current = await this.storage.chatQuota.getOrCreate(chatId);
    const normalized = cloneQuota(current);
    normalizeWindows(normalized, new Date());
    return this.toReport(normalized);
  }

  async canPassiveReply(chatId: number): Promise<boolean> {
    const report = await this.getReport(chatId);
    return (
      report.daily.conversations < report.plan.conversationDaily &&
      report.hourly.conversations < report.plan.conversationHourly &&
      report.hourly.passiveReplies < report.plan.passiveHourly &&
      report.daily.llmTokens + tokenReservationFor(report.plan) <= report.plan.llmTokensDaily
    );
  }

  async admitConversation(input: {
    chatId: number;
    telegramId: number;
    passive: boolean;
    reserveTokens?: boolean;
  }): Promise<QuotaDecision> {
    return this.mutate(input.chatId, (doc, plan, now) => {
      const userKey = String(input.telegramId);
      const lastUser = doc.lastUserRequestAt[userKey];
      const userCooldownMs = plan.antiFlood.userCooldownSeconds * 1000;
      const chatCooldownMs = plan.antiFlood.chatCooldownSeconds * 1000;
      if (lastUser && now.getTime() - lastUser.getTime() < userCooldownMs) {
        return denied('user_cooldown', remainingSeconds(lastUser, userCooldownMs, now));
      }
      if (
        doc.lastChatRequestAt &&
        now.getTime() - doc.lastChatRequestAt.getTime() < chatCooldownMs
      ) {
        return denied(
          'chat_cooldown',
          remainingSeconds(doc.lastChatRequestAt, chatCooldownMs, now),
        );
      }
      if ((doc.minute.userRequests[userKey] ?? 0) >= plan.antiFlood.userBurstPerMinute) {
        return denied('user_burst', secondsToNextMinute(now));
      }
      if (doc.minute.chatRequests >= plan.antiFlood.chatBurstPerMinute) {
        return denied('chat_burst', secondsToNextMinute(now));
      }
      if (doc.daily.conversations >= plan.conversationDaily) return denied('conversation_daily');
      if (doc.hourly.conversations >= plan.conversationHourly) return denied('conversation_hourly');
      if (input.passive && doc.hourly.passiveReplies >= plan.passiveHourly) {
        return denied('passive_hourly');
      }
      const tokenReservation = input.reserveTokens === false ? 0 : tokenReservationFor(plan);
      if (doc.daily.llmTokens + tokenReservation > plan.llmTokensDaily) {
        return denied('llm_tokens');
      }

      doc.daily.conversations += 1;
      doc.daily.llmTokens += tokenReservation;
      doc.hourly.conversations += 1;
      if (input.passive) doc.hourly.passiveReplies += 1;
      doc.minute.chatRequests += 1;
      doc.minute.userRequests[userKey] = (doc.minute.userRequests[userKey] ?? 0) + 1;
      doc.lastChatRequestAt = now;
      doc.lastUserRequestAt[userKey] = now;
      return { allowed: true, ...(tokenReservation > 0 ? { tokenReservation } : {}) };
    });
  }

  async reserve(chatId: number, resource: QuotaResource, amount = 1): Promise<QuotaDecision> {
    if (amount <= 0) return { allowed: true };
    return this.mutate(chatId, (doc, plan) => {
      const { counter, limit } = resourceLimit(doc, plan, resource);
      if (counter + amount > limit) return denied(resource);
      incrementResource(doc, resource, amount);
      return { allowed: true };
    });
  }

  /** Adjust the daily token ledger after a completed turn. Overages block the following turn. */
  async recordLlmTokens(chatId: number, tokens: number, reservedTokens = 0): Promise<void> {
    if (tokens <= 0 && reservedTokens <= 0) return;
    await this.mutate(chatId, (doc) => {
      doc.daily.llmTokens = Math.max(0, doc.daily.llmTokens + tokens - reservedTokens);
      return { allowed: true };
    });
  }

  private async mutate(
    chatId: number,
    apply: (doc: ChatQuotaDoc, plan: QuotaPlan, now: Date) => QuotaDecision,
  ): Promise<QuotaDecision> {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
      const current = await this.storage.chatQuota.getOrCreate(chatId);
      const next = cloneQuota(current);
      const now = new Date();
      normalizeWindows(next, now);
      const decision = apply(next, QUOTA_PLANS[next.plan], now);
      if (!decision.allowed) return decision;
      next.version = current.version + 1;
      next.updatedAt = now;
      if (await this.storage.chatQuota.compareAndSet(next, current.version)) return decision;
    }
    return denied('chat_burst', 1);
  }

  private toReport(doc: ChatQuotaDoc): GroupQuotaReport {
    return {
      plan: QUOTA_PLANS[doc.plan],
      daily: { ...doc.daily },
      hourly: { ...doc.hourly },
      dayKey: doc.dayKey,
      hourKey: doc.hourKey,
    };
  }
}

function resourceLimit(
  doc: ChatQuotaDoc,
  plan: QuotaPlan,
  resource: QuotaResource,
): { counter: number; limit: number } {
  switch (resource) {
    case 'web_search':
      return { counter: doc.daily.webSearches, limit: plan.webSearchDaily };
    case 'page_scan':
      return { counter: doc.daily.pageScans, limit: plan.pageScanDaily };
    case 'news':
      return { counter: doc.daily.news, limit: plan.newsDaily };
    case 'image':
      return { counter: doc.daily.images, limit: plan.imagesDaily };
    case 'media':
      return { counter: doc.daily.media, limit: plan.mediaDaily };
    case 'media_bytes':
      return { counter: doc.daily.mediaBytes, limit: plan.mediaBytesDaily };
  }
}

function incrementResource(doc: ChatQuotaDoc, resource: QuotaResource, amount: number): void {
  switch (resource) {
    case 'web_search':
      doc.daily.webSearches += amount;
      return;
    case 'page_scan':
      doc.daily.pageScans += amount;
      return;
    case 'news':
      doc.daily.news += amount;
      return;
    case 'image':
      doc.daily.images += amount;
      return;
    case 'media':
      doc.daily.media += amount;
      return;
    case 'media_bytes':
      doc.daily.mediaBytes += amount;
      return;
  }
}

function normalizeWindows(doc: ChatQuotaDoc, now: Date): void {
  const dayKey = zonedKey(now, false);
  const hourKey = zonedKey(now, true);
  const minuteKey = `${hourKey}:${zonedPart(now, 'minute')}`;
  if (doc.dayKey !== dayKey) {
    doc.dayKey = dayKey;
    doc.daily = emptyDailyCounters();
  }
  if (doc.hourKey !== hourKey) {
    doc.hourKey = hourKey;
    doc.hourly = emptyHourlyCounters();
  }
  if (doc.minuteKey !== minuteKey) {
    doc.minuteKey = minuteKey;
    doc.minute = { chatRequests: 0, userRequests: {} };
    doc.lastUserRequestAt = {};
    doc.lastChatRequestAt = undefined;
  }
}

function zonedKey(now: Date, includeHour: boolean): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(includeHour ? { hour: '2-digit', hourCycle: 'h23' as const } : {}),
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '00';
  return includeHour
    ? `${read('year')}-${read('month')}-${read('day')}-${read('hour')}`
    : `${read('year')}-${read('month')}-${read('day')}`;
}

function zonedPart(now: Date, type: Intl.DateTimeFormatPartTypes): string {
  return (
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE,
      minute: '2-digit',
    })
      .formatToParts(now)
      .find((part) => part.type === type)?.value ?? '00'
  );
}

function cloneQuota(doc: ChatQuotaDoc): ChatQuotaDoc {
  return {
    ...doc,
    daily: { ...doc.daily },
    hourly: { ...doc.hourly },
    minute: { chatRequests: doc.minute.chatRequests, userRequests: { ...doc.minute.userRequests } },
    lastUserRequestAt: { ...doc.lastUserRequestAt },
  };
}

function denied(reason: QuotaDenyReason, retryAfterSeconds?: number): QuotaDecision {
  return {
    allowed: false,
    reason,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}

function remainingSeconds(last: Date, cooldownMs: number, now: Date): number {
  return Math.max(1, Math.ceil((cooldownMs - (now.getTime() - last.getTime())) / 1000));
}

function secondsToNextMinute(now: Date): number {
  return Math.max(1, 60 - now.getUTCSeconds());
}

function tokenReservationFor(plan: QuotaPlan): number {
  return Math.max(1, Math.floor(plan.llmTokensDaily / plan.conversationDaily));
}
