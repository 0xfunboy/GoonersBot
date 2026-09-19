import type { Update } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import { ConversationExecutor } from '../src/companion/ingress/executor.js';
import {
  DurableUpdateProcessor,
  type UpdateInboxStore,
} from '../src/companion/ingress/processor.js';
import type { UpdateInboxDoc } from '../src/domain/entities.js';
import type { UpdateInboxClaim } from '../src/storage/repositories/updateInbox.js';

const waitUntil = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
};

class MemoryInbox implements UpdateInboxStore {
  readonly docs = new Map<number, UpdateInboxDoc>();
  readonly heartbeat = vi.fn(async (claim: UpdateInboxClaim) => this.matches(claim));

  add(updateId: number, conversationKey: string): void {
    const now = new Date(updateId);
    this.docs.set(updateId, {
      botId: 'bot-a',
      updateId,
      conversationKey,
      actorTelegramId: updateId,
      chatId: Number(conversationKey.split(':')[1]),
      payload: { update_id: updateId },
      payloadBytes: 16,
      status: 'queued',
      attempts: 0,
      fence: 0,
      ownerId: null,
      leaseUntil: null,
      receivedAt: now,
      updatedAt: now,
    });
  }

  async adoptLegacy(): Promise<number> {
    return 0;
  }

  async quarantineExpired(): Promise<number> {
    return 0;
  }

  async listQueued(_botId: string, limit = 32): Promise<UpdateInboxDoc[]> {
    return [...this.docs.values()]
      .filter((doc) => doc.status === 'queued')
      .sort((a, b) => a.updateId - b.updateId)
      .slice(0, limit);
  }

  async claim(
    botId: string,
    updateId: number,
    ownerId: string,
    now = new Date(),
    leaseMs = 300_000,
  ): Promise<UpdateInboxClaim | null> {
    const doc = this.docs.get(updateId);
    if (!doc || doc.botId !== botId || doc.status !== 'queued') return null;
    doc.status = 'running';
    doc.ownerId = ownerId;
    doc.fence += 1;
    doc.attempts += 1;
    doc.leaseUntil = new Date(now.getTime() + leaseMs);
    return { botId, updateId, ownerId, fence: doc.fence };
  }

  async complete(claim: UpdateInboxClaim): Promise<boolean> {
    const doc = this.docs.get(claim.updateId);
    if (!doc || !this.matches(claim)) return false;
    doc.status = 'done';
    doc.payload = undefined;
    return true;
  }

  async fail(claim: UpdateInboxClaim): Promise<boolean> {
    const doc = this.docs.get(claim.updateId);
    if (!doc || !this.matches(claim)) return false;
    doc.status = 'failed';
    doc.payload = undefined;
    return true;
  }

  private matches(claim: UpdateInboxClaim): boolean {
    const doc = this.docs.get(claim.updateId);
    return Boolean(
      doc &&
      doc.status === 'running' &&
      doc.botId === claim.botId &&
      doc.ownerId === claim.ownerId &&
      doc.fence === claim.fence,
    );
  }
}

describe('durable Telegram update processor', () => {
  it('keeps recovery and new arrivals on one ordered path without blocking another chat', async () => {
    const store = new MemoryInbox();
    store.add(1, 'chat:1');
    const executor = new ConversationExecutor(2, 8);
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const processor = new DurableUpdateProcessor({
      botId: 'bot-a',
      ownerId: 'worker-a',
      store,
      executor,
      leaseMs: 60_000,
      handleUpdate: async (update: Update) => {
        if (update.update_id === 1) {
          events.push('one:start');
          await firstGate;
          events.push('one:end');
          return;
        }
        events.push(update.update_id === 2 ? 'two' : 'other');
      },
    });

    await processor.start();
    await waitUntil(() => events.includes('one:start'));
    store.add(2, 'chat:1');
    store.add(3, 'chat:2');
    processor.wake();
    await waitUntil(() => events.includes('other'));
    expect(events).toEqual(['one:start', 'other']);

    releaseFirst();
    await waitUntil(() => [...store.docs.values()].every((doc) => doc.status === 'done'));
    await processor.stop();
    expect(events).toEqual(['one:start', 'other', 'one:end', 'two']);
  });

  it('heartbeats work held beyond its initial lease and rejects a second owner', async () => {
    const store = new MemoryInbox();
    store.add(9, 'chat:9');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processor = new DurableUpdateProcessor({
      botId: 'bot-a',
      ownerId: 'worker-a',
      store,
      executor: new ConversationExecutor(1, 4),
      leaseMs: 30,
      handleUpdate: () => gate,
    });

    await processor.start();
    await waitUntil(() => store.heartbeat.mock.calls.length >= 2);
    await expect(store.claim('bot-a', 9, 'worker-b', new Date(), 30)).resolves.toBeNull();
    release();
    await waitUntil(() => store.docs.get(9)?.status === 'done');
    await processor.stop();
  });
});
