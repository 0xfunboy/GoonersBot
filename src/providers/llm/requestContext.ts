import { AsyncLocalStorage } from 'node:async_hooks';

import type { QuotaPlanId } from '../../quota/plans.js';
import type { TokenUsage } from './types.js';

interface LlmRequestContext {
  groupPlan: QuotaPlanId;
  usage: {
    inputTokens: number;
    outputTokens: number;
    estimated: boolean;
    calls: number;
  };
}

const storage = new AsyncLocalStorage<LlmRequestContext>();

/** Scope every LLM call made for one Telegram update to its group's quota plan. */
export function runWithGroupPlan<T>(groupPlan: QuotaPlanId, task: () => Promise<T>): Promise<T> {
  return storage.run(
    {
      groupPlan,
      usage: { inputTokens: 0, outputTokens: 0, estimated: false, calls: 0 },
    },
    task,
  );
}

export function currentGroupPlan(): QuotaPlanId | undefined {
  return storage.getStore()?.groupPlan;
}

/** Provider-level accounting catches every internal call, including JSON repair and agent planning. */
export function recordCurrentLlmUsage(usage: TokenUsage): void {
  const current = storage.getStore()?.usage;
  if (!current) return;
  current.inputTokens += Math.max(0, usage.inputTokens ?? 0);
  current.outputTokens += Math.max(0, usage.outputTokens ?? 0);
  current.estimated ||= usage.estimated;
  current.calls += 1;
}

export function currentLlmUsage():
  | { inputTokens: number; outputTokens: number; estimated: boolean; calls: number }
  | undefined {
  const usage = storage.getStore()?.usage;
  return usage ? { ...usage } : undefined;
}
