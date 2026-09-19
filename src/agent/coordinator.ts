import type { FinalAnswerComposer } from './composer.js';
import type { ToolOrchestrator } from './orchestrator.js';
import type { MultiActionPlanner } from './planner.js';
import type { AgentPlanningContext, CoordinatedAgentResult } from './types.js';
import type { AgentActionPlan } from './schemas.js';
import type { AgentExecutionReport } from './types.js';
import {
  evaluateProgress,
  strategyKey,
  validateReadRevision,
  type ContinuationStore,
} from './progress.js';
import {
  TaskRetryableError,
  TaskAuthorityError,
  TaskEffectUnknownError,
} from '../companion/tasks/contracts.js';
import { validateActionPlan } from './planValidator.js';

/**
 * Thin end-to-end facade: understand → plan a DAG → execute registered tools → verify → compose.
 *
 * Telegram integration can adopt this incrementally without coupling the orchestration core to
 * transport handlers or to the legacy single-action reply pipeline.
 */
export class AgentCoordinator {
  constructor(
    private readonly planner: MultiActionPlanner,
    private readonly orchestrator: ToolOrchestrator,
    private readonly composer: FinalAnswerComposer,
    private readonly revise?: (
      context: AgentPlanningContext,
      report: AgentExecutionReport,
      strategies: readonly string[],
      signal?: AbortSignal,
    ) => Promise<AgentActionPlan | null>,
  ) {}

  async run(
    context: AgentPlanningContext,
    options: {
      metadata?: Readonly<Record<string, unknown>>;
      signal?: AbortSignal;
      continuation?: ContinuationStore;
      refreshTone?: () => Promise<string | undefined>;
    } = {},
  ): Promise<CoordinatedAgentResult> {
    const restored = options.continuation?.load();
    let plan = restored
      ? validateActionPlan(restored.plan, context.availableTools)
      : await this.planner.plan(context, options.signal);
    let revisions = Math.max(restored?.revisions ?? 0, options.continuation?.usedRevisions ?? 0);
    const maxRevisions = Math.min(2, Math.max(0, options.continuation?.maxRevisions ?? 2));
    const strategies = [
      ...new Set([...(restored?.strategies ?? []), ...plan.actions.map(strategyKey)]),
    ];
    // The first provider can request a scheduled retry: persist identities before any effect.
    await options.continuation?.save({
      plan,
      revisions,
      strategies,
      lastDecision: restored?.lastDecision,
    });
    let execution = await this.orchestrator.execute(plan, {
      request: context.request,
      metadata: options.metadata,
      signal: options.signal,
    });
    let decision = evaluateProgress(context, execution, {
      revisions,
      maxRevisions,
      previous: restored?.lastDecision,
      signal: options.signal,
      canRevise: Boolean(this.revise),
    });
    await options.continuation?.save({ plan, revisions, strategies, lastDecision: decision });
    while (
      decision.decision === 'revise' &&
      this.revise &&
      revisions < maxRevisions &&
      !options.signal?.aborted
    ) {
      // Consume the revision before model/network work, so a crash never resets the budget.
      revisions += 1;
      await options.continuation?.save({ plan, revisions, strategies, lastDecision: decision });
      const revised = await this.revise(context, execution, strategies, options.signal).catch(
        (error: unknown) => {
          if (
            error instanceof TaskRetryableError ||
            error instanceof TaskAuthorityError ||
            error instanceof TaskEffectUnknownError ||
            options.signal?.aborted
          )
            throw error;
          return null;
        },
      );
      let validated: AgentActionPlan | null = null;
      if (revised) {
        try {
          const candidate = validateActionPlan(revised, context.availableTools);
          if (validateReadRevision(context, execution, candidate, strategies))
            validated = candidate;
        } catch {
          /* A malformed alternative cannot drop or replace the original deliverables. */
        }
      }
      if (!validated) {
        decision = evaluateProgress(context, execution, {
          revisions,
          maxRevisions,
          previous: decision,
          signal: options.signal,
          canRevise: false,
          reason:
            'No new compatible read strategy was supplied; retain the original result identities and observed failures.',
        });
        break;
      }
      plan = validated;
      decision = {
        ...decision,
        revision: revisions,
        nextSteps: plan.actions
          .filter((action) => !strategies.includes(strategyKey(action)))
          .map((action) => ({
            actionId: action.id,
            tool: action.tool,
            strategy: strategyKey(action),
            reason:
              'Different read query or same-origin URL actually observed in provider evidence; requested identity and acceptance are unchanged.',
          })),
      };
      strategies.push(...plan.actions.map(strategyKey));
      await options.continuation?.save({
        plan,
        revisions,
        strategies: [...new Set(strategies)].slice(-40),
        lastDecision: decision,
      });
      execution = await this.orchestrator.execute(plan, {
        request: context.request,
        metadata: options.metadata,
        signal: options.signal,
        previousResults: execution.results,
      });
      decision = evaluateProgress(context, execution, {
        revisions,
        maxRevisions,
        previous: decision,
        signal: options.signal,
        canRevise: Boolean(this.revise),
      });
      await options.continuation?.save({
        plan,
        revisions,
        strategies: [...new Set(strategies)].slice(-40),
        lastDecision: decision,
      });
    }
    execution = { ...execution, progress: decision };
    await options.continuation?.save({
      plan,
      revisions,
      strategies: [...new Set(strategies)].slice(-40),
      lastDecision: decision,
    });
    const refreshedTone = await options.refreshTone?.();
    const answer = await this.composer.compose(execution, {
      request: context.request,
      model: context.model,
      socialContract: refreshedTone ?? context.finalTone,
      signal: options.signal,
    });
    return { plan, execution, answer, nextStep: decision };
  }
}
