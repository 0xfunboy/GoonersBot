import {
  agentActionPlanSchema,
  type AgentActionPlan,
  type AgentToolName,
  type PlannedAction,
} from './schemas.js';
import type { AgentToolDefinition } from './types.js';
import { z } from 'zod';

/** Host policy supplies the default and ceiling, but never lengthens an explicit short deadline. */
export function resolveActionTimeout(timeoutMs?: number, hostTimeoutMs?: number): number {
  const ceiling =
    hostTimeoutMs === undefined
      ? 900_000
      : Math.max(500, Math.min(900_000, Math.round(hostTimeoutMs)));
  return Math.min(timeoutMs ?? (hostTimeoutMs === undefined ? 30_000 : ceiling), ceiling);
}

/** Apply host defaults BEFORE schema parsing would erase an omitted deadline with its generic 30s. */
export function actionPlanSchemaForDefinitions(definitions: AgentToolDefinition[]) {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  return z.preprocess((candidate) => {
    if (!candidate || typeof candidate !== 'object' || !('actions' in candidate)) return candidate;
    if (!Array.isArray(candidate.actions)) return candidate;
    return {
      ...candidate,
      actions: candidate.actions.map((action: unknown) => {
        if (!action || typeof action !== 'object' || !('tool' in action)) return action;
        if ('timeoutMs' in action && action.timeoutMs !== undefined) return action;
        const definition = byName.get(action.tool as AgentToolName);
        return { ...action, timeoutMs: resolveActionTimeout(undefined, definition?.timeoutMs) };
      }),
    };
  }, agentActionPlanSchema);
}

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
  const parsed = actionPlanSchemaForDefinitions(definitions).safeParse(candidate);
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
    action.timeoutMs = resolveActionTimeout(action.timeoutMs, definition.timeoutMs);
    const inputProblems = definition.validateInput?.(action) ?? [];
    if (inputProblems.length > 0) {
      throw new ActionPlanValidationError(
        `invalid input for ${action.tool}: ${inputProblems.join('; ')}`,
      );
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
