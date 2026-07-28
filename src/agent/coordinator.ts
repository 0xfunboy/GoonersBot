import type { FinalAnswerComposer } from './composer.js';
import type { ToolOrchestrator } from './orchestrator.js';
import type { MultiActionPlanner } from './planner.js';
import type { AgentPlanningContext, CoordinatedAgentResult } from './types.js';

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
  ) {}

  async run(
    context: AgentPlanningContext,
    options: {
      metadata?: Readonly<Record<string, unknown>>;
      signal?: AbortSignal;
    } = {},
  ): Promise<CoordinatedAgentResult> {
    const plan = await this.planner.plan(context, options.signal);
    const execution = await this.orchestrator.execute(plan, {
      request: context.request,
      metadata: options.metadata,
      signal: options.signal,
    });
    const answer = await this.composer.compose(execution, {
      request: context.request,
      model: context.model,
      socialContract: context.finalTone,
      signal: options.signal,
    });
    return { plan, execution, answer };
  }
}
