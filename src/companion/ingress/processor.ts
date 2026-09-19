import { randomUUID } from 'node:crypto';
import type { Update } from 'grammy/types';
import type { UpdateInboxDoc } from '../../domain/entities.js';
import type { UpdateInboxClaim, UpdateInboxRepo } from '../../storage/repositories/updateInbox.js';
import { childLogger } from '../../utils/logger.js';
import { ConversationExecutor, QueueCapacityError } from './executor.js';

const log = childLogger('companion-ingress-processor');

export type UpdateInboxStore = Pick<
  UpdateInboxRepo,
  'claim' | 'complete' | 'fail' | 'heartbeat' | 'listQueued' | 'quarantineExpired' | 'adoptLegacy'
>;

export interface DurableUpdateProcessorOptions {
  botId: string;
  store: UpdateInboxStore;
  executor: ConversationExecutor;
  leaseMs: number;
  handleUpdate: (update: Update) => Promise<void>;
  ownerId?: string;
}

/**
 * The sole bridge from durable receipts to grammY handlers. All live and recovered work follows
 * this same ordered path; claim happens only when an executor permit is actually available.
 */
export class DurableUpdateProcessor {
  readonly ownerId: string;
  private started = false;
  private stopping = false;
  private pumping: Promise<void> | null = null;
  private wakeRequested = false;
  private readonly scheduled = new Set<string>();

  constructor(private readonly options: DurableUpdateProcessorOptions) {
    this.ownerId = options.ownerId ?? randomUUID();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.options.store.adoptLegacy(this.options.botId);
    const quarantined = await this.options.store.quarantineExpired(this.options.botId);
    if (quarantined > 0) {
      log.warn(
        { botId: this.options.botId, quarantined },
        'quarantined updates with an unknown external-effect outcome',
      );
    }
    this.wake();
  }

  wake(): void {
    if (!this.started || this.stopping) return;
    this.wakeRequested = true;
    if (this.pumping) return;
    this.pumping = this.pumpLoop()
      .catch((error) => log.error({ err: error }, 'durable inbox pump failed'))
      .finally(() => {
        this.pumping = null;
        if (this.wakeRequested && !this.stopping) this.wake();
      });
  }

  async stop(timeoutMs = 15_000): Promise<void> {
    this.stopping = true;
    await this.pumping;
    await this.options.executor.drain(timeoutMs);
  }

  private async pumpLoop(): Promise<void> {
    do {
      this.wakeRequested = false;
      const available = this.options.executor.remainingCapacity;
      if (available <= 0) return;
      const entries = await this.options.store.listQueued(this.options.botId, available);
      let accepted = 0;
      for (const entry of entries) {
        if (!entry.payload) continue;
        const key = `${entry.botId}:${entry.updateId}`;
        if (this.scheduled.has(key)) continue;
        this.scheduled.add(key);
        try {
          const job = this.options.executor.enqueue(entry.conversationKey, () =>
            this.process(entry),
          );
          accepted += 1;
          void job
            .catch((error) =>
              this.options.executor.reportFailure(error, {
                botId: entry.botId,
                updateId: entry.updateId,
                conversationKey: entry.conversationKey,
              }),
            )
            .finally(() => {
              this.scheduled.delete(key);
              this.wake();
            });
        } catch (error) {
          this.scheduled.delete(key);
          if (error instanceof QueueCapacityError) return;
          throw error;
        }
      }
      // Entries already scheduled can be returned by Mongo until their task reaches claim(). Do
      // not spin; their completion will wake the pump again.
      if (accepted === 0) return;
    } while (this.wakeRequested && !this.stopping);
  }

  private async process(entry: UpdateInboxDoc): Promise<void> {
    const claim = await this.options.store.claim(
      this.options.botId,
      entry.updateId,
      this.ownerId,
      new Date(),
      this.options.leaseMs,
    );
    if (!claim || !entry.payload) return;

    let leaseLost = false;
    const heartbeatEveryMs = Math.max(10, Math.floor(this.options.leaseMs / 3));
    const heartbeat = setInterval(() => {
      void this.options.store
        .heartbeat(claim, new Date(), this.options.leaseMs)
        .then((renewed) => {
          if (!renewed) leaseLost = true;
        })
        .catch((error) => {
          leaseLost = true;
          log.error(
            { err: error, updateId: entry.updateId, ownerId: claim.ownerId },
            'Telegram update lease heartbeat failed',
          );
        });
    }, heartbeatEveryMs);
    heartbeat.unref();

    try {
      await this.options.handleUpdate(entry.payload as unknown as Update);
      const completed = await this.options.store.complete(claim);
      if (!completed || leaseLost) {
        log.error(
          { updateId: entry.updateId, ownerId: claim.ownerId, fence: claim.fence },
          'handler finished after losing its fenced Telegram update claim',
        );
      }
    } catch (error) {
      await this.persistFailure(claim, entry, error);
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async persistFailure(
    claim: UpdateInboxClaim,
    entry: UpdateInboxDoc,
    error: unknown,
  ): Promise<void> {
    await this.options.store
      .fail(claim, error)
      .catch((persistError) =>
        log.error(
          { err: persistError, updateId: entry.updateId, ownerId: claim.ownerId },
          'failed to persist Telegram handler failure',
        ),
      );
  }
}
