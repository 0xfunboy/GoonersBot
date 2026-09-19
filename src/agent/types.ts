import type {
  ActionArtifact,
  ActionEvidence,
  AgentActionPlan,
  AgentToolName,
  PlannedAction,
} from './schemas.js';
import type { OperationRequest } from '../companion/capabilities/dispatch.js';

export type ToolRisk = 'read' | 'compute' | 'generate' | 'external_write';

export interface AgentToolDefinition {
  name: AgentToolName;
  description: string;
  risk: ToolRisk;
  /** Planner-side budget; the validator rejects plans that exceed it. */
  maxCalls?: number;
  /** Host default and maximum timeout; an explicitly shorter action deadline is preserved. */
  timeoutMs?: number;
  /** Maximum artifacts one action may claim for each transport kind. */
  maxArtifactsPerKind?: Partial<Record<ActionArtifact['kind'], number>>;
  /** Host-side manifest validation after model planning, before any handler can run. */
  validateInput?: (action: PlannedAction) => string[];
  /** Manifest output validation in addition to the action's acceptance contract. */
  validateOutput?: (action: PlannedAction, output: ToolExecutionOutput) => string[];
}

export interface AgentPlanningContext {
  request: string;
  language?: string;
  currentHandle?: string;
  chatSummary?: string;
  recentMessages?: Array<{ handle: string; text: string }>;
  relevantPeople?: Array<{ handle: string; context: string }>;
  availableTools: AgentToolDefinition[];
  /**
   * A deterministic upstream intent (normally Cortex). The planning model may improve it, but if
   * JSON planning fails these calls still compile into an executable DAG instead of degrading to
   * the first legacy tool.
   */
  requestedActions?: Array<{
    tool: AgentToolName;
    query?: string;
    args?: Record<string, unknown>;
    reason?: string;
    operationRequest?: OperationRequest;
  }>;
  finalTone?: string;
  model?: string;
}

export interface ToolExecutionOutput {
  /** Short factual summary suitable for the final answer composer. */
  summary: string;
  /** Structured output remains available to dependent actions, but is truncated before LLM use. */
  data?: unknown;
  evidence?: ActionEvidence[];
  artifacts?: ActionArtifact[];
  confidence?: number;
  /** A tool can explicitly fail semantic verification despite returning normally. */
  verified?: boolean;
}

export interface ToolExecutionContext {
  request: string;
  action: PlannedAction;
  dependencies: ReadonlyMap<string, ToolExecutionOutput>;
  signal: AbortSignal;
  metadata: Readonly<Record<string, unknown>>;
}

export type AgentToolHandler = (context: ToolExecutionContext) => Promise<ToolExecutionOutput>;
export type AgentToolRegistry = Partial<Record<AgentToolName, AgentToolHandler>>;

export type ActionRunStatus = 'succeeded' | 'failed' | 'timed_out' | 'skipped';

export interface ActionRunResult {
  action: PlannedAction;
  status: ActionRunStatus;
  startedAt: Date;
  durationMs: number;
  output?: ToolExecutionOutput;
  error?: string;
  verificationProblems: string[];
}

export interface AgentExecutionReport {
  progress?: import('./progress.js').NextStepDecision;
  plan: AgentActionPlan;
  status: 'complete' | 'partial' | 'failed';
  startedAt: Date;
  durationMs: number;
  results: ActionRunResult[];
}

export interface CompositeAnswer {
  message: string;
  status: AgentExecutionReport['status'];
  usedActionIds: string[];
  uncertainties: string[];
  evidence: ActionEvidence[];
  artifacts: ActionArtifact[];
  /** True means every action represented as completed passed its declared acceptance checks. */
  verified: boolean;
}

export interface CoordinatedAgentResult {
  nextStep?: import('./progress.js').NextStepDecision;
  plan: AgentActionPlan;
  execution: AgentExecutionReport;
  answer: CompositeAnswer;
}
