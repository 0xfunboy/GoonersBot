import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { PlannedAction } from '../../agent/schemas.js';
import type { ToolExecutionOutput } from '../../agent/types.js';
import { verifyOutput } from '../../agent/orchestrator.js';
import {
  operationIdForInvocation,
  runtimeCapabilityManifest,
  validateCapabilityOutput,
} from '../capabilities/catalog.js';
import type { TaskExecutionContext } from './service.js';
import { TaskRetryableError } from './contracts.js';

export interface DurableActionCodec {
  /** Replace every binary output with a scoped artifact reference before durable storage. */
  encode(output: ToolExecutionOutput): Promise<unknown>;
  /** Resolve and validate references, preserving the exact structured output for dependencies. */
  decode(stored: unknown): Promise<ToolExecutionOutput>;
}

interface StoredActionOutput {
  version: 1;
  signature: string;
  output: unknown;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Do not infer retryability from an arbitrary provider error or retry an aborted operation. */
export function isTransientReadFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const details = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    name?: unknown;
    message?: unknown;
  };
  const status = details.status ?? details.statusCode;
  if ([429, 502, 503, 504].includes(Number(status))) return true;
  if (
    [
      'ETIMEDOUT',
      'ECONNRESET',
      'EAI_AGAIN',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
    ].includes(String(details.code))
  )
    return true;
  if (details.name === 'TimeoutError') return true;
  return (
    typeof details.message === 'string' &&
    /\b(?:HTTP|status(?: code)?)\s*[:=]?\s*(?:429|502|503|504)\b/i.test(details.message)
  );
}

/**
 * Resume one bound action, not the whole conversation. Read/compute success becomes a checkpoint;
 * every effect receives a durable intent/receipt. A successful generation is never repeated merely
 * because a later dependency or the final composer failed.
 */
export async function runDurableAction(
  context: TaskExecutionContext,
  action: PlannedAction,
  invoke: () => Promise<ToolExecutionOutput>,
  codec: DurableActionCodec,
  actionSignal?: AbortSignal,
): Promise<ToolExecutionOutput> {
  const signal = actionSignal ? AbortSignal.any([context.signal, actionSignal]) : context.signal;
  const authority = async (): Promise<void> => {
    signal.throwIfAborted();
    await context.assertAuthority();
    signal.throwIfAborted();
  };
  await authority();
  const manifest = runtimeCapabilityManifest(action.tool);
  const operationId = operationIdForInvocation(action.tool, action.args);
  const operation = manifest.operations.find((item) => item.id === operationId);
  if (!operation) throw new Error(`Unknown operation for durable action ${action.tool}`);
  const signature = createHash('sha256')
    .update(
      stableJson({
        // Unchanged public reads survive language/tone corrections. Context-dependent and effect
        // outputs stay revision-scoped; their inputs can include material outside action.args.
        version: ['web_search', 'page_scan', 'news', 'knowledge_rag'].includes(action.tool)
          ? 0
          : context.task.contract.acceptedVersion,
        requestId: action.requestId ?? action.id,
        tool: action.tool,
        operation: operationId,
        query: action.query,
        args: action.args,
        acceptance: action.acceptance,
      }),
    )
    .digest('hex')
    .slice(0, 32);
  const prefix = `step:${action.tool}:${signature}`;
  const verify = (output: ToolExecutionOutput): boolean =>
    verifyOutput(action, output, {
      name: action.tool,
      description: manifest.description,
      risk: manifest.adapterRisk,
      validateOutput: (planned, actual) => validateCapabilityOutput(planned.tool, planned, actual),
    }).length === 0;

  if (!['read', 'compute'].includes(operation.effect)) {
    const stored = await context.effect(
      `${prefix}:effect`,
      async (): Promise<StoredActionOutput> => {
        await authority();
        const output = await invoke();
        await authority();
        // Also retain an unverified response as an effect receipt: repeating it could charge/send twice.
        const encoded = await codec.encode(output);
        return { version: 1, signature, output: encoded };
      },
    );
    await authority();
    if (stored.version !== 1 || stored.signature !== signature)
      throw new Error('Durable effect output signature mismatch');
    const output = await codec.decode(stored.output);
    await authority();
    return output;
  }

  const previous = context.getCheckpoint<StoredActionOutput>(prefix);
  if (previous) {
    if (previous.version !== 1 || previous.signature !== signature)
      throw new Error('Durable action checkpoint signature mismatch');
    const restored = await codec.decode(previous.output);
    await authority();
    if (!verify(restored))
      throw new Error('Stored action output no longer satisfies its acceptance contract');
    return restored;
  }
  const attemptsKey = `${prefix}:attempts`;
  let attempts = context.getCheckpoint<number>(attemptsKey) ?? 0;
  if (!Number.isSafeInteger(attempts) || attempts < 0)
    throw new Error('Invalid persisted action attempt count');
  const resumeKey = `${prefix}:resumeAt`;
  const resumeAt = context.getCheckpoint<number>(resumeKey);
  if (resumeAt && resumeAt > Date.now())
    throw new TaskRetryableError(
      'Attendo il prossimo tentativo del provider.',
      resumeAt - Date.now(),
    );
  while (attempts < 3) {
    await authority();
    attempts += 1;
    await context.checkpoint(attemptsKey, attempts);
    let output: ToolExecutionOutput;
    try {
      output = await invoke();
    } catch (error) {
      // Only a completed read handler may schedule after its per-action timeout. A still-running
      // SDK, task cancellation or lost lease must never be interpreted as permission to retry.
      if (
        actionSignal?.aborted &&
        !context.signal.aborted &&
        actionSignal.reason instanceof Error &&
        /tool timed out/i.test(actionSignal.reason.message) &&
        attempts < 3
      ) {
        await context.assertAuthority();
        await context.checkpoint(resumeKey, Date.now() + 5000);
        throw new TaskRetryableError('La lettura è scaduta; riprenderò dal passo rimasto.', 5000);
      }
      await authority();
      if (attempts >= 3 || !isTransientReadFailure(error)) throw error;
      const suppliedDelay =
        error && typeof error === 'object' && 'retryAfterMs' in error
          ? Number(error.retryAfterMs)
          : 0;
      const retryAfterMs = Number.isFinite(suppliedDelay)
        ? Math.min(300_000, Math.max(0, suppliedDelay))
        : 0;
      if (attempts >= 2 || retryAfterMs >= 1000) {
        const waitMs = Math.max(5000, retryAfterMs);
        await context.checkpoint(resumeKey, Date.now() + waitMs);
        throw new TaskRetryableError(
          'Il provider è temporaneamente indisponibile; il lavoro riprenderà automaticamente.',
          waitMs,
        );
      }
      // One short retry is local. Longer waits release the lane and survive restart.
      await delay(400 * attempts, undefined, { signal });
      continue;
    }
    await authority();
    if (verify(output)) {
      const encoded = await codec.encode(output);
      await authority();
      await context.checkpoint(prefix, {
        version: 1,
        signature,
        output: encoded,
      } satisfies StoredActionOutput);
    }
    // Semantic failures remain visible to the coordinator; they are not transient network failures.
    return output;
  }
  throw new Error('Durable action retry budget exhausted; previous attempts are preserved');
}
