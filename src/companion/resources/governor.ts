export type ResourceKind =
  | 'interactive'
  | 'network'
  | 'media'
  | 'browser'
  | 'generation'
  | 'mining'
  | 'subprocess';

export type ResourcePriority = 'interactive' | 'background';

export interface ResourceWait {
  resource: ResourceKind;
  reason:
    | 'concurrency'
    | 'interactive_reserve'
    | 'memory_pressure'
    | 'disk_pressure'
    | 'shared_concurrency';
  queuedAt: number;
}

export interface ResourceAdmissionOptions {
  ownerKey?: string;
  priority?: ResourcePriority;
  maxWaitMs?: number;
  onWait?: (wait: ResourceWait) => void | Promise<void>;
}

interface Waiter {
  resource: ResourceKind;
  ownerKey: string;
  priority: ResourcePriority;
  queuedAt: number;
  signal?: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  onAbort?: () => void;
}

export interface ResourceGovernorConfig {
  concurrency?: number;
  interactiveReserve?: number;
  maxPending?: number;
  limits?: Partial<Record<ResourceKind, number>>;
  host?: HostResourceCoordinator;
}

const DEFAULT_LIMITS: Record<ResourceKind, number> = {
  interactive: 4,
  network: 4,
  media: 2,
  browser: 1,
  generation: 2,
  mining: 1,
  subprocess: 2,
};

/** Bounded local admission, with a reserved interactive lane and fair rotation across owners. */
export class ResourceGovernor {
  private readonly concurrency: number;
  private readonly interactiveReserve: number;
  private readonly maxPending: number;
  private readonly limits: Record<ResourceKind, number>;
  private readonly active = new Map<ResourceKind, number>();
  private readonly queue: Waiter[] = [];
  private totalActive = 0;
  private backgroundActive = 0;
  private lastOwner: string | undefined;
  private closed = false;

  constructor(private readonly config: ResourceGovernorConfig = {}) {
    this.concurrency = config.concurrency ?? 8;
    this.interactiveReserve = config.interactiveReserve ?? Math.min(2, this.concurrency - 1);
    this.maxPending = config.maxPending ?? 128;
    this.limits = { ...DEFAULT_LIMITS, ...config.limits };
    if (
      !Number.isSafeInteger(this.concurrency) ||
      this.concurrency < 1 ||
      !Number.isSafeInteger(this.interactiveReserve) ||
      this.interactiveReserve < 0 ||
      this.interactiveReserve >= this.concurrency ||
      !Number.isSafeInteger(this.maxPending) ||
      this.maxPending < 1 ||
      Object.values(this.limits).some((limit) => !Number.isSafeInteger(limit) || limit < 1)
    )
      throw new TypeError('invalid resource governor limits');
  }

  get snapshot(): {
    active: number;
    queued: number;
    byResource: Partial<Record<ResourceKind, number>>;
  } {
    return {
      active: this.totalActive,
      queued: this.queue.length,
      byResource: Object.fromEntries(this.active),
    };
  }

  async run<T>(
    resource: ResourceKind,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
    options: ResourceAdmissionOptions = {},
  ): Promise<T> {
    const admissionStartedAt = Date.now();
    const release = await this.acquire(resource, signal, options);
    try {
      signal?.throwIfAborted();
      if (this.config.host) {
        return await this.config.host.run(
          resource,
          signal,
          operation,
          Math.max(1, (options.maxWaitMs ?? 30_000) - (Date.now() - admissionStartedAt)),
          (reason) => {
            try {
              void Promise.resolve(
                options.onWait?.({
                  resource,
                  reason: reason as ResourceWait['reason'],
                  queuedAt: Date.now(),
                }),
              ).catch(() => undefined);
            } catch {
              /* reporting is non-authoritative */
            }
          },
        );
      }
      return await operation();
    } finally {
      release();
    }
  }

  /** Stop new work and reject queued admissions. Active callers retain their cancellation owner. */
  close(): void {
    this.closed = true;
    for (const waiter of [...this.queue])
      this.rejectWaiter(waiter, new Error('resource governor stopped'));
  }

  private acquire(
    resource: ResourceKind,
    signal: AbortSignal | undefined,
    options: ResourceAdmissionOptions,
  ): Promise<() => void> {
    if (this.closed) return Promise.reject(new Error('resource governor stopped'));
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const maxWaitMs = options.maxWaitMs ?? 30_000;
    if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0)
      return Promise.reject(new TypeError('resource wait must be positive'));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resource,
        signal,
        resolve,
        reject,
        ownerKey: options.ownerKey ?? 'unscoped',
        priority: options.priority ?? (resource === 'interactive' ? 'interactive' : 'background'),
        queuedAt: Date.now(),
      };
      // A full background queue must not block an immediately available interactive reservation.
      if (this.queue.length >= this.maxPending && !this.eligible(waiter)) {
        reject(new Error('resource queue capacity reached'));
        return;
      }
      waiter.onAbort = () => this.rejectWaiter(waiter, abortError(signal));
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      waiter.timer = setTimeout(
        () => this.rejectWaiter(waiter, new Error(`waiting for ${resource} capacity timed out`)),
        maxWaitMs,
      );
      this.queue.push(waiter);
      this.drain();
      if (this.queue.includes(waiter)) {
        try {
          const notification = options.onWait?.({
            resource,
            queuedAt: waiter.queuedAt,
            reason:
              this.backgroundActive >= this.concurrency - this.interactiveReserve
                ? 'interactive_reserve'
                : 'concurrency',
          });
          void Promise.resolve(notification).catch(() => undefined);
        } catch {
          // Progress reporting must never lose an admission or leak a permit.
        }
      }
    });
  }

  private eligible(waiter: Waiter): boolean {
    return (
      this.totalActive < this.concurrency &&
      (this.active.get(waiter.resource) ?? 0) < this.limits[waiter.resource] &&
      (waiter.priority === 'interactive' ||
        this.backgroundActive < this.concurrency - this.interactiveReserve)
    );
  }

  private drain(): void {
    while (!this.closed) {
      const eligible = this.queue.filter((waiter) => this.eligible(waiter));
      if (eligible.length === 0) return;
      // Aging prevents an endless sequence of quick interactive calls starving queued work.
      const aged = eligible.filter((waiter) => Date.now() - waiter.queuedAt >= 5_000);
      const priority = aged.length
        ? aged
        : eligible.filter((waiter) => waiter.priority === 'interactive');
      const candidates = priority.length ? priority : eligible;
      const waiter =
        candidates.find((candidate) => candidate.ownerKey !== this.lastOwner) ?? candidates[0]!;
      this.removeWaiter(waiter);
      this.lastOwner = waiter.ownerKey;
      this.totalActive += 1;
      if (waiter.priority === 'background') this.backgroundActive += 1;
      this.active.set(waiter.resource, (this.active.get(waiter.resource) ?? 0) + 1);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.totalActive -= 1;
        if (waiter.priority === 'background') this.backgroundActive -= 1;
        this.active.set(waiter.resource, (this.active.get(waiter.resource) ?? 1) - 1);
        this.drain();
      });
    }
  }

  private removeWaiter(waiter: Waiter): void {
    const index = this.queue.indexOf(waiter);
    if (index !== -1) this.queue.splice(index, 1);
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort);
  }

  private rejectWaiter(waiter: Waiter, error: Error): void {
    if (!this.queue.includes(waiter)) return;
    this.removeWaiter(waiter);
    waiter.reject(error);
    this.drain();
  }
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('resource wait cancelled');
}

export const resourceGovernor = new ResourceGovernor({ host: hostResourceCoordinator });
import { hostResourceCoordinator, type HostResourceCoordinator } from './host.js';
