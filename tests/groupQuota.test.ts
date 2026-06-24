import { describe, expect, it } from 'vitest';
import type { ChatQuotaDoc } from '../src/domain/entities.js';
import { GroupQuotaService } from '../src/services/groupQuota.js';
import { emptyQuota } from '../src/storage/repositories/chatQuota.js';
import { fakeStorage } from './helpers.js';

function quotaService() {
  let doc: ChatQuotaDoc | undefined;
  const storage = fakeStorage({
    chatQuota: {
      async getOrCreate(chatId: number) {
        doc ??= emptyQuota(chatId, 'free', new Date());
        return doc;
      },
      async compareAndSet(next: ChatQuotaDoc, expectedVersion: number) {
        if (!doc || doc.version !== expectedVersion) return false;
        doc = next;
        return true;
      },
    },
  });
  return { service: new GroupQuotaService(storage), getDoc: () => doc };
}

describe('GroupQuotaService', () => {
  it('defaults groups to the free plan and exposes its limits', async () => {
    const { service } = quotaService();
    const report = await service.getReport(-100);
    expect(report.plan.id).toBe('free');
    expect(report.plan.conversationDaily).toBe(12);
    expect(report.plan.imagesDaily).toBe(1);
    expect(report.plan.mediaBytesDaily).toBe(100 * 1024 * 1024);
  });

  it('enforces the free image cap durably', async () => {
    const { service } = quotaService();
    for (let n = 0; n < 1; n += 1) {
      expect((await service.reserve(-100, 'image')).allowed).toBe(true);
    }
    const denied = await service.reserve(-100, 'image');
    expect(denied).toMatchObject({ allowed: false, reason: 'image' });
  });

  it('applies anti-flood before a second immediate request from the same user', async () => {
    const { service } = quotaService();
    expect(
      await service.admitConversation({ chatId: -100, telegramId: 42, passive: false }),
    ).toMatchObject({
      allowed: true,
    });
    expect(
      await service.admitConversation({ chatId: -100, telegramId: 42, passive: false }),
    ).toMatchObject({
      allowed: false,
      reason: 'user_cooldown',
    });
  });

  it('changes the entire policy through one plan assignment', async () => {
    const { service } = quotaService();
    const report = await service.setPlan(-100, 'pro');
    expect(report.plan.conversationHourly).toBe(18);
    expect(report.plan.webSearchDaily).toBe(75);
    expect(report.plan.imagesDaily).toBe(48);
  });

  it('blocks passive replies after the plan-specific hourly allowance', async () => {
    const { service, getDoc } = quotaService();
    await service.admitConversation({ chatId: -100, telegramId: 1, passive: false });
    const doc = getDoc();
    if (!doc) throw new Error('quota document missing');
    doc.hourly.passiveReplies = 0;
    expect(await service.canPassiveReply(-100)).toBe(false);
  });
});
