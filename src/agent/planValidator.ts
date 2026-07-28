import {
  agentActionPlanSchema,
  type AgentActionPlan,
  type AgentToolName,
  type PlannedAction,
} from './schemas.js';
import type { AgentToolDefinition } from './types.js';

export class ActionPlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionPlanValidationError';
  }
}

/**
 * Validate both graph shape and runtime capability policy.
 *
 * The LLM cannot invent executable capability names: a tool must exist in the closed schema and
 * in the exact per-turn allow-list supplied by the application.
 */
export function validateActionPlan(
  candidate: unknown,
  definitions: AgentToolDefinition[],
): AgentActionPlan {
  const parsed = agentActionPlanSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ActionPlanValidationError(
      parsed.error.issues.map((issue) => issue.message).join('; '),
    );
  }

  const definitionsByName = new Map(definitions.map((definition) => [definition.name, definition]));
  const callCounts = new Map<AgentToolName, number>();
  for (const action of parsed.data.actions) {
    const definition = definitionsByName.get(action.tool);
    if (!definition) {
      throw new ActionPlanValidationError(`tool is not available this turn: ${action.tool}`);
    }
    const nextCount = (callCounts.get(action.tool) ?? 0) + 1;
    callCounts.set(action.tool, nextCount);
    if (definition.maxCalls !== undefined && nextCount > definition.maxCalls) {
      throw new ActionPlanValidationError(
        `tool ${action.tool} exceeds its per-plan call budget (${definition.maxCalls})`,
      );
    }
    if (definition.timeoutMs !== undefined) {
      action.timeoutMs = Math.max(500, Math.min(900_000, Math.round(definition.timeoutMs)));
    }
  }
  return parsed.data;
}

/** Stable topological layers. Independent actions in the same layer may execute concurrently. */
export function actionLayers(actions: PlannedAction[]): PlannedAction[][] {
  const remaining = new Map(actions.map((action) => [action.id, action]));
  const completed = new Set<string>();
  const layers: PlannedAction[][] = [];

  while (remaining.size > 0) {
    const ready = actions.filter(
      (action) =>
        remaining.has(action.id) &&
        action.dependsOn.every((dependency) => completed.has(dependency)),
    );
    if (ready.length === 0) {
      throw new ActionPlanValidationError('action graph cannot be topologically ordered');
    }
    layers.push(ready);
    for (const action of ready) {
      remaining.delete(action.id);
      completed.add(action.id);
    }
  }

  return layers;
}
