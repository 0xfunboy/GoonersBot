import { childLogger } from '../utils/logger.js';
import { actionLayers, validateActionPlan } from './planValidator.js';
import type { AgentToolName, PlannedAction } from './schemas.js';
import type {
  ActionRunResult,
  AgentExecutionReport,
  AgentToolDefinition,
  AgentToolRegistry,
  ToolExecutionOutput,
} from './types.js';

const log = childLogger('agent-orchestrator');

export interface ToolOrchestratorOptions {
  maxConcurrency?: number;
  allowExternalWrites?: boolean;
  /** Time allowed for a handler to acknowledge cancellation before status becomes unconfirmed. */
  cancellationGraceMs?: number;
}

export interface ExecutePlanOptions {
  request: string;
  metadata?: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}

/**
 * Executes a validated DAG through an explicit registry.
 *
 * Tool code receives structured dependency outputs instead of interpolated shell/code templates.
 * This keeps orchestration composable without creating an arbitrary-code execution primitive.
 */
export class ToolOrchestrator {
  private readonly maxConcurrency: number;
  private readonly allowExternalWrites: boolean;
  private readonly cancellationGraceMs: number;

  constructor(
    private readonly definitions: AgentToolDefinition[],
    private readonly registry: AgentToolRegistry,
    options: ToolOrchestratorOptions = {},
  ) {
    this.maxConcurrency = Math.max(1, Math.min(8, options.maxConcurrency ?? 3));
    this.allowExternalWrites = options.allowExternalWrites ?? false;
    this.cancellationGraceMs = Math.max(10, options.cancellationGraceMs ?? 2_000);
  }

  async execute(candidate: unknown, options: ExecutePlanOptions): Promise<AgentExecutionReport> {
    const startedAt = new Date();
    const started = Date.now();
    const plan = validateActionPlan(candidate, this.definitions);
    const completed = new Map<string, ActionRunResult>();

    for (const layer of actionLayers(plan.actions)) {
      for (let offset = 0; offset < layer.length; offset += this.maxConcurrency) {
        const batch = layer.slice(offset, offset + this.maxConcurrency);
        const results = await Promise.all(
          batch.map((action) => this.runOrSkip(action, completed, options)),
        );
        for (const result of results) completed.set(result.action.id, result);
      }
    }

    const results = plan.actions
      .map((action) => completed.get(action.id))
      .filter((result): result is ActionRunResult => Boolean(result));
    return {
      plan,
      status: reportStatus(results),
      startedAt,
      durationMs: Date.now() - started,
      results,
    };
  }

  private async runOrSkip(
    action: PlannedAction,
    completed: ReadonlyMap<string, ActionRunResult>,
    options: ExecutePlanOptions,
  ): Promise<ActionRunResult> {
    const startedAt = new Date();
    const blockedBy = action.dependsOn.filter((id) => completed.get(id)?.status !== 'succeeded');
    if (blockedBy.length > 0) {
      return {
        action,
        status: 'skipped',
        startedAt,
        durationMs: 0,
        error: `blocked by failed dependencies: ${blockedBy.join(', ')}`,
        verificationProblems: [],
      };
    }

    const definition = this.definitions.find((item) => item.name === action.tool);
    if (definition?.risk === 'external_write' && !this.allowExternalWrites) {
      return {
        action,
        status: 'skipped',
        startedAt,
        durationMs: 0,
        error: 'external write requires explicit host authorization',
        verificationProblems: [],
      };
    }

    const handler = this.registry[action.tool];
    if (!handler) {
      return {
        action,
        status: 'failed',
        startedAt,
        durationMs: 0,
        error: `no registered handler for ${action.tool}`,
        verificationProblems: [],
      };
    }

    const dependencyOutputs = new Map<string, ToolExecutionOutput>();
    for (const id of action.dependsOn) {
      const output = completed.get(id)?.output;
      if (output) dependencyOutputs.set(id, output);
    }

    const started = Date.now();
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });
    if (options.signal?.aborted) onExternalAbort();
    const timeout = setTimeout(
      () => controller.abort(new Error(`tool timed out after ${action.timeoutMs}ms`)),
      action.timeoutMs,
    );

    try {
      const handlerPromise = handler({
        request: options.request,
        action,
        dependencies: dependencyOutputs,
        signal: controller.signal,
        metadata: options.metadata ?? {},
      });
      const settledHandler = settle(handlerPromise);
      const first = await Promise.race([
        settledHandler,
        waitForAbort(controller.signal).then(() => ({ state: 'aborted' as const })),
      ]);
      if (first.state === 'aborted') {
        const settledAfterAbort = await Promise.race([
          settledHandler,
          delay(this.cancellationGraceMs).then(() => ({ state: 'unconfirmed' as const })),
        ]);
        if (settledAfterAbort.state === 'unconfirmed') {
          return {
            action,
            status: 'failed',
            startedAt,
            durationMs: Date.now() - started,
            error:
              'cancellation was requested but the tool did not confirm it; the underlying job may still be running',
            verificationProblems: [],
          };
        }
        const reason =
          controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error('tool execution aborted');
        return {
          action,
          status: isTimeoutReason(reason) ? 'timed_out' : 'failed',
          startedAt,
          durationMs: Date.now() - started,
          error: errorMessage(reason),
          verificationProblems: [],
        };
      }
      if (first.state === 'rejected') throw first.error;
      const output = first.value;
      const verificationProblems = verifyOutput(action, output, definition);
      if (verificationProblems.length > 0) {
        return {
          action,
          status: 'failed',
          startedAt,
          durationMs: Date.now() - started,
          output,
          error: `verification failed: ${verificationProblems.join('; ')}`,
          verificationProblems,
        };
      }
      return {
        action,
        status: 'succeeded',
        startedAt,
        durationMs: Date.now() - started,
        output: normalizeOutput(output),
        verificationProblems: [],
      };
    } catch (error) {
      const timedOut =
        controller.signal.aborted &&
        controller.signal.reason instanceof Error &&
        /timed out/i.test(controller.signal.reason.message);
      log.warn({ error, actionId: action.id, tool: action.tool }, 'agent tool action failed');
      return {
        action,
        status: timedOut ? 'timed_out' : 'failed',
        startedAt,
        durationMs: Date.now() - started,
        error: errorMessage(error),
        verificationProblems: [],
      };
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}

export function verifyOutput(
  action: PlannedAction,
  output: ToolExecutionOutput,
  definition?: AgentToolDefinition,
): string[] {
  const problems: string[] = [];
  if (output.verified === false) problems.push('tool explicitly marked output unverified');
  if (
    action.acceptance.requireOutput &&
    !output.summary.trim() &&
    output.data === undefined &&
    (output.artifacts?.length ?? 0) === 0
  ) {
    problems.push('missing output');
  }
  if ((output.evidence?.length ?? 0) < action.acceptance.minEvidence) {
    problems.push(
      `expected at least ${action.acceptance.minEvidence} evidence item(s), got ${output.evidence?.length ?? 0}`,
    );
  }
  const artifactKinds = new Set(output.artifacts?.map((artifact) => artifact.kind) ?? []);
  for (const kind of action.acceptance.requiredArtifactKinds) {
    if (!artifactKinds.has(kind)) problems.push(`missing required ${kind} artifact`);
  }
  if (definition?.maxArtifactsPerKind) {
    const counts = new Map<string, number>();
    for (const artifact of output.artifacts ?? []) {
      counts.set(artifact.kind, (counts.get(artifact.kind) ?? 0) + 1);
    }
    for (const [kind, maximum] of Object.entries(definition.maxArtifactsPerKind)) {
      const actual = counts.get(kind) ?? 0;
      if (maximum !== undefined && actual > maximum) {
        problems.push(
          `tool produced ${actual} ${kind} artifacts but transport can deliver ${maximum}`,
        );
      }
    }
  }
  return problems;
}

function normalizeOutput(output: ToolExecutionOutput): ToolExecutionOutput {
  return {
    ...output,
    summary: output.summary.trim().slice(0, 6_000),
    evidence: output.evidence?.slice(0, 30),
    artifacts: output.artifacts?.slice(0, 20),
    ...(output.confidence !== undefined
      ? { confidence: Math.max(0, Math.min(1, output.confidence)) }
      : {}),
  };
}

function reportStatus(results: ActionRunResult[]): AgentExecutionReport['status'] {
  const requiredFailure = results.some(
    (result) => result.status !== 'succeeded' && !result.action.optional,
  );
  if (requiredFailure) return 'failed';
  return results.some((result) => result.status !== 'succeeded') ? 'partial' : 'complete';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 1_000);
  return String(error).slice(0, 1_000);
}

type Settled<T> = { state: 'fulfilled'; value: T } | { state: 'rejected'; error: unknown };

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ state: 'fulfilled', value }),
    (error: unknown) => ({ state: 'rejected', error }),
  );
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTimeoutReason(error: Error): boolean {
  return /timed out/i.test(error.message);
}

/** Convenience helper for building registries without widening keys to arbitrary strings. */
export function defineAgentTools(
  registry: Partial<Record<AgentToolName, AgentToolRegistry[AgentToolName]>>,
): AgentToolRegistry {
  return registry;
}
