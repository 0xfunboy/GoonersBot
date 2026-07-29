import type { LLMProvider } from '../providers/llm/types.js';
import { childLogger } from '../utils/logger.js';
import { composedAnswerDraftSchema } from './schemas.js';
import type {
  ActionRunResult,
  AgentExecutionReport,
  CompositeAnswer,
  ToolExecutionOutput,
} from './types.js';

const log = childLogger('agent-composer');

const COMPOSER_SYSTEM = [
  'You compose the final answer for a capable community assistant.',
  'Return ONLY schema-valid JSON.',
  'Use the successful tool results together; do not merely list tool steps.',
  'Lead with the actual deliverable or answer. Be useful, specific and naturally concise.',
  'Never claim a failed/skipped action succeeded. Mention a material limitation plainly.',
  'Only make sourced factual claims supported by the supplied evidence.',
  'Artifacts have already been produced by tools: refer to them naturally, never invent one.',
  'Transport happens after composition: say an artifact is ready/attached, never claim Telegram',
  'delivery was confirmed or quote a message id.',
  'The NON-NEGOTIABLE SOCIAL CONTRACT in the prompt overrides personality and banter.',
  'Match the requested language and tone. Friendly vulgar banter may season the answer, but must',
  'never displace the useful payload or target protected traits.',
  'Use plain text by default. If structure helps, use only CommonMark bold, italic, links, bullets',
  'and fenced code. Never emit HTML or Markdown tables.',
].join('\n');

export interface FinalAnswerComposerConfig {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export class FinalAnswerComposer {
  constructor(
    private readonly llm: LLMProvider | null,
    private readonly config: FinalAnswerComposerConfig = {},
  ) {}

  async compose(
    report: AgentExecutionReport,
    options: {
      request: string;
      model?: string;
      socialContract?: string;
      signal?: AbortSignal;
    } = { request: '' },
  ): Promise<CompositeAnswer> {
    const deterministic = deterministicAnswer(report);
    if (!this.llm?.capabilities.chat || report.results.length === 0) return deterministic;

    try {
      const draft = await this.llm.jsonCompletion({
        system: COMPOSER_SYSTEM,
        prompt: buildCompositionPrompt(report, options.request, options.socialContract),
        schema: composedAnswerDraftSchema,
        temperature: this.config.temperature ?? 0.25,
        maxTokens: this.config.maxTokens ?? 1_600,
        ...((options.model ?? this.config.model)
          ? { model: options.model ?? this.config.model }
          : {}),
        signal: options.signal,
      });
      if (!draft) return deterministic;

      const successfulIds = new Set(
        report.results
          .filter((result) => result.status === 'succeeded')
          .map((result) => result.action.id),
      );
      const usedActionIds = [...new Set(draft.usedActionIds)].filter((id) => successfulIds.has(id));
      const materialFailures = failureLines(report.results);
      const draftUncertainties = draft.uncertainties ?? [];
      const message = materialFailures.length
        ? `${draft.message.trim()}\n\nLimiti: ${materialFailures.join('; ')}.`
        : draft.message.trim();

      return assembleAnswer(report, message, usedActionIds, [
        ...draftUncertainties,
        ...materialFailures,
      ]);
    } catch (error) {
      log.warn({ error }, 'final answer composition failed; using deterministic result');
      return deterministic;
    }
  }
}

export function buildCompositionPrompt(
  report: AgentExecutionReport,
  request: string,
  socialContract?: string,
): string {
  const results = report.results.map((result) => ({
    id: result.action.id,
    tool: result.action.tool,
    purpose: result.action.purpose,
    status: result.status,
    optional: result.action.optional,
    summary: result.output?.summary,
    data: compactData(result.output?.data),
    evidence: result.output?.evidence,
    artifacts: result.output?.artifacts,
    error: result.error,
  }));
  return [
    `ORIGINAL REQUEST: ${request.slice(0, 4_000)}`,
    socialContract
      ? `NON-NEGOTIABLE SOCIAL CONTRACT: ${socialContract.slice(0, 800)}`
      : 'NON-NEGOTIABLE SOCIAL CONTRACT: complete the useful work before any personality color',
    `EXECUTION STATUS: ${report.status}`,
    `FINAL CONTRACT: ${JSON.stringify(report.plan.finalResponse)}`,
    'VERIFIED ACTION RESULTS:',
    JSON.stringify(results).slice(0, 24_000),
    'Compose one coherent final response. List usedActionIds and real uncertainties.',
  ].join('\n');
}

function deterministicAnswer(report: AgentExecutionReport): CompositeAnswer {
  const successes = report.results.filter((result) => result.status === 'succeeded');
  const summaries = successes
    .map((result) => result.output?.summary.trim())
    .filter((summary): summary is string => Boolean(summary));
  const failures = failureLines(report.results);
  let message: string;
  if (summaries.length > 0) {
    message = summaries.join('\n\n');
    if (failures.length > 0) message += `\n\nLimiti: ${failures.join('; ')}.`;
  } else if (failures.length > 0) {
    message = `Non sono riuscito a completare la richiesta: ${failures.join('; ')}.`;
  } else {
    message = 'Non servivano strumenti per questa richiesta.';
  }
  return assembleAnswer(
    report,
    message,
    successes.map((result) => result.action.id),
    failures,
  );
}

function assembleAnswer(
  report: AgentExecutionReport,
  message: string,
  usedActionIds: string[],
  uncertainties: string[],
): CompositeAnswer {
  const succeeded = report.results.filter((result) => result.status === 'succeeded');
  return {
    message,
    status: report.status,
    usedActionIds,
    uncertainties: [...new Set(uncertainties)],
    evidence: dedupeOutputs(succeeded, 'evidence'),
    artifacts: dedupeOutputs(succeeded, 'artifacts'),
    verified:
      report.status !== 'failed' &&
      usedActionIds.every((id) =>
        report.results.some(
          (result) =>
            result.action.id === id &&
            result.status === 'succeeded' &&
            result.verificationProblems.length === 0,
        ),
      ),
  };
}

function failureLines(results: ActionRunResult[]): string[] {
  return results
    .filter((result) => result.status !== 'succeeded')
    .map(
      (result) =>
        `${result.action.purpose} (${result.status}${result.error ? `: ${result.error}` : ''})`,
    );
}

function dedupeOutputs<K extends 'evidence' | 'artifacts'>(
  results: ActionRunResult[],
  key: K,
): NonNullable<ToolExecutionOutput[K]> {
  const seen = new Set<string>();
  const values: Array<NonNullable<ToolExecutionOutput[K]>[number]> = [];
  for (const result of results) {
    for (const value of result.output?.[key] ?? []) {
      const identity = JSON.stringify(value);
      if (!seen.has(identity)) {
        seen.add(identity);
        values.push(value);
      }
    }
  }
  return values as NonNullable<ToolExecutionOutput[K]>;
}

function compactData(data: unknown): unknown {
  if (data === undefined) return undefined;
  if (Buffer.isBuffer(data)) return `[binary ${data.length} bytes]`;
  if (data instanceof Uint8Array) return `[binary ${data.byteLength} bytes]`;
  if (data instanceof Date) return data.toISOString();
  if (typeof data === 'string') return data.slice(0, 2_000);
  if (typeof data === 'number' || typeof data === 'boolean' || data === null) return data;
  if (Array.isArray(data)) return data.slice(0, 20).map((value) => compactDataDepth(value, 1));
  if (typeof data === 'object') return compactDataDepth(data, 1);
  return String(data).slice(0, 500);
}

function compactDataDepth(data: unknown, depth: number): unknown {
  if (depth > 4) return '[nested data omitted]';
  if (Buffer.isBuffer(data)) return `[binary ${data.length} bytes]`;
  if (data instanceof Uint8Array) return `[binary ${data.byteLength} bytes]`;
  if (data instanceof Date) return data.toISOString();
  if (typeof data === 'string') return data.slice(0, 2_000);
  if (typeof data === 'number' || typeof data === 'boolean' || data === null) return data;
  if (Array.isArray(data)) {
    const values = data.slice(0, 20).map((value) => compactDataDepth(value, depth + 1));
    return data.length > values.length
      ? [...values, `[${data.length - values.length} omitted]`]
      : values;
  }
  if (typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>).slice(0, 30);
    return Object.fromEntries(
      entries.map(([key, value]) => [key.slice(0, 100), compactDataDepth(value, depth + 1)]),
    );
  }
  return String(data).slice(0, 500);
}
