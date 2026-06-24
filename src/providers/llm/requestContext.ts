import { AsyncLocalStorage } from 'node:async_hooks';

import type { QuotaPlanId } from '../../quota/plans.js';

interface LlmRequestContext {
  groupPlan: QuotaPlanId;
}

const storage = new AsyncLocalStorage<LlmRequestContext>();

/** Scope every LLM call made for one Telegram update to its group's quota plan. */
export function runWithGroupPlan<T>(groupPlan: QuotaPlanId, task: () => Promise<T>): Promise<T> {
  return storage.run({ groupPlan }, task);
}

export function currentGroupPlan(): QuotaPlanId | undefined {
  return storage.getStore()?.groupPlan;
}
