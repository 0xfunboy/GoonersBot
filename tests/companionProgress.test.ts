import { describe, expect, it, vi } from 'vitest';
import { AgentCoordinator } from '../src/agent/coordinator.js';
import { ToolOrchestrator } from '../src/agent/orchestrator.js';
import { agentActionPlanSchema } from '../src/agent/schemas.js';
import {
  evaluateProgress,
  evidenceUrlAlternatives,
  reviseFailedReads,
  strategyKey,
  validateReadRevision,
  type ContinuationState,
} from '../src/agent/progress.js';
import { TaskRetryableError } from '../src/companion/tasks/contracts.js';
import type { AgentExecutionReport } from '../src/agent/types.js';

describe('bounded semantic continuation', () => {
  it('changes failed search strategy while retaining an already successful effect and original deliverables', async () => {
    const plan = agentActionPlanSchema.parse({
      goal: 'Find source and make document',
      actions: [
        { id: 'search', tool: 'web_search', query: 'first query', purpose: 'find source' },
        { id: 'file', tool: 'document_create', purpose: 'create independent file' },
      ],
    });
    const search = vi
      .fn()
      .mockResolvedValueOnce({ summary: 'No relevant result', verified: false })
      .mockResolvedValue({
        summary: 'Source found',
        verified: true,
        evidence: [{ source: 'https://example.org' }],
      });
    const create = vi.fn().mockResolvedValue({ summary: 'Created', verified: true });
    const definitions = [
      { name: 'web_search' as const, description: 'search', risk: 'read' as const, maxCalls: 1 },
      {
        name: 'document_create' as const,
        description: 'file',
        risk: 'generate' as const,
        maxCalls: 1,
      },
    ];
    const llm = {
      jsonCompletion: vi.fn().mockResolvedValue({
        changes: [
          { actionId: 'search', query: 'better query', reason: 'official source' },
          { actionId: 'file', query: 'must not repeat', reason: 'not allowed' },
        ],
      }),
    };
    const compose = vi
      .fn()
      .mockResolvedValue({ message: 'Done', status: 'complete', evidence: [], artifacts: [] });
    const coordinator = new AgentCoordinator(
      { plan: async () => plan } as never,
      new ToolOrchestrator(definitions, { web_search: search, document_create: create }),
      { compose } as never,
      (context, report, strategies, signal) =>
        reviseFailedReads(llm as never, context, report, strategies, signal),
    );
    let stored: ContinuationState | undefined;
    const result = await coordinator.run(
      { request: plan.goal, availableTools: definitions },
      {
        continuation: {
          load: () => stored,
          save: async (state) => {
            stored = structuredClone(state);
          },
        },
        refreshTone: async () => 'No jokes; answer precisely',
      },
    );
    expect(search).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.execution.status).toBe('complete');
    expect(result.plan.actions.map((action) => action.id)).toEqual(['search', 'file']);
    expect(stored?.revisions).toBe(1);
    expect(result.nextStep).toMatchObject({
      decision: 'complete',
      satisfiedDeliverableIds: ['search', 'file'],
      progress: { newVerifiedResults: 1, newEvidence: 1 },
    });
    expect(compose.mock.calls[0]?.[1].socialContract).toBe('No jokes; answer precisely');
  });

  it('does not reset persisted revision budgets on a new run', async () => {
    const plan = agentActionPlanSchema.parse({
      goal: 'research',
      actions: [{ id: 'search', tool: 'web_search', query: 'query', purpose: 'find source' }],
    });
    const definitions = [
      { name: 'web_search' as const, description: 'search', risk: 'read' as const },
    ];
    const revise = vi.fn();
    const coordinator = new AgentCoordinator(
      { plan: async () => plan } as never,
      new ToolOrchestrator(definitions, {
        web_search: async () => ({ summary: 'unavailable', verified: false }),
      }),
      { compose: async () => ({ message: 'unavailable' }) } as never,
      revise,
    );
    await coordinator.run(
      { request: 'research', availableTools: definitions },
      { continuation: { load: () => undefined, save: vi.fn(), usedRevisions: 2, maxRevisions: 2 } },
    );
    expect(revise).not.toHaveBeenCalled();
  });

  it('persists the first plan before a scheduled retry and reuses its action identities on resume', async () => {
    const plan = agentActionPlanSchema.parse({
      goal: 'research',
      actions: [{ id: 'search', tool: 'web_search', query: 'query', purpose: 'source' }],
    });
    const definitions = [
      { name: 'web_search' as const, description: 'search', risk: 'read' as const },
    ];
    let stored: ContinuationState | undefined;
    const search = vi
      .fn()
      .mockImplementationOnce(async () => {
        expect(stored?.plan.actions[0]?.id).toBe('search');
        throw new TaskRetryableError('cooldown', 5000);
      })
      .mockResolvedValue({ summary: 'Found', verified: true });
    const planner = { plan: vi.fn().mockResolvedValue(plan) };
    const coordinator = new AgentCoordinator(
      planner as never,
      new ToolOrchestrator(definitions, { web_search: search }),
      { compose: async () => ({ message: 'ok' }) } as never,
    );
    const options = {
      continuation: {
        load: () => stored,
        save: async (state: ContinuationState) => {
          stored = structuredClone(state);
        },
      },
    };
    await expect(
      coordinator.run({ request: 'research', availableTools: definitions }, options),
    ).rejects.toBeInstanceOf(TaskRetryableError);
    const resumed = await coordinator.run(
      { request: 'research', availableTools: definitions },
      options,
    );
    expect(planner.plan).toHaveBeenCalledTimes(1);
    expect(resumed.nextStep?.decision).toBe('complete');
  });

  it('measures all actions of each deliverable and retains correction feedback and terminal causes', () => {
    const plan = agentActionPlanSchema.parse({
      goal: 'Find actual episode',
      actions: [
        { id: 'search', requestId: 'episode', tool: 'web_search', purpose: 'verify source' },
        { id: 'scan', requestId: 'episode', tool: 'page_scan', purpose: 'verify episode' },
      ],
    });
    const report: AgentExecutionReport = {
      plan,
      status: 'partial',
      startedAt: new Date(),
      durationMs: 0,
      results: plan.actions.map((action, index) => ({
        action,
        status: index ? 'failed' : 'succeeded',
        startedAt: new Date(),
        durationMs: 0,
        output: index
          ? undefined
          : { summary: 'Source', verified: true, evidence: [{ source: 'https://example.org' }] },
        error: index ? 'No matching episode' : undefined,
        verificationProblems: [],
      })),
    };
    const context = {
      request: 'Quello era un trailer, voglio l’episodio completo',
      availableTools: [],
    };
    const first = evaluateProgress(context, report, { revisions: 0 });
    expect(first).toMatchObject({
      decision: 'partial',
      satisfiedDeliverableIds: [],
      missingDeliverableIds: ['episode'],
    });
    expect(first.reason).toContain('era un trailer');
    expect(
      evaluateProgress(context, report, { revisions: 0, previous: first }).progress.newEvidence,
    ).toBe(0);
    report.results[1]!.error = '403 permission denied';
    expect(evaluateProgress(context, report, { revisions: 0 }).decision).toBe('access');
    report.results[1]!.error = 'External effect has an unconfirmed outcome';
    expect(evaluateProgress(context, report, { revisions: 0 }).decision).toBe('uncertain');
    report.results[1]!.error = 'No matching episode';
    expect(evaluateProgress(context, report, { revisions: 2 }).decision).toBe('budget');
    expect(
      evaluateProgress(context, report, { revisions: 0, signal: AbortSignal.abort() }).decision,
    ).toBe('cancelled');
  });

  it('accepts only observed same-origin page alternatives and preserves acceptance/effects/IDs', async () => {
    const plan = agentActionPlanSchema.parse({
      goal: 'Audit selected source',
      actions: [
        { id: 'search', tool: 'web_search', purpose: 'find exact source' },
        {
          id: 'scan',
          requestId: 'audit',
          tool: 'page_scan',
          purpose: 'audit',
          dependsOn: ['search'],
          dependencyBindings: [
            { fromOperationId: 'search', select: 'evidence_url', target: 'args.url' },
          ],
        },
      ],
    });
    const report: AgentExecutionReport = {
      plan,
      status: 'partial',
      startedAt: new Date(),
      durationMs: 0,
      results: plan.actions.map((action, index) => ({
        action,
        status: index ? 'failed' : 'succeeded',
        startedAt: new Date(),
        durationMs: 0,
        verificationProblems: [],
        output: index
          ? undefined
          : {
              summary: 'Sources',
              verified: true,
              evidence: [
                'https://example.org/broken',
                'https://example.org/current',
                'https://other.example.org/unrelated',
                'http://127.0.0.1/private',
              ].map((source) => ({ source })),
            },
      })),
    };
    const context = {
      request: 'Audit selected source',
      availableTools: [
        { name: 'web_search' as const, description: 'search', risk: 'read' as const },
        { name: 'page_scan' as const, description: 'scan', risk: 'read' as const },
      ],
    };
    expect(evidenceUrlAlternatives(plan.actions[1]!, report)).toEqual([
      'https://example.org/current',
    ]);
    const llm = {
      jsonCompletion: vi.fn().mockResolvedValue({
        changes: [
          {
            actionId: 'scan',
            url: 'https://example.org/current',
            reason: 'observed alternate source',
          },
        ],
      }),
    };
    const revised = await reviseFailedReads(
      llm as never,
      context,
      report,
      plan.actions.map(strategyKey),
    );
    expect(revised?.actions[1]).toMatchObject({
      requestId: 'audit',
      args: { url: 'https://example.org/current' },
      dependencyBindings: [],
    });
    expect(
      validateReadRevision(
        context,
        report,
        { ...revised!, actions: revised!.actions.slice(1) },
        [],
      ),
    ).toBe(false);
    expect(validateReadRevision(context, report, revised!, revised!.actions.map(strategyKey))).toBe(
      false,
    );
    llm.jsonCompletion.mockResolvedValue({
      changes: [{ actionId: 'scan', url: 'https://example.org/invented', reason: 'guess' }],
    });
    expect(await reviseFailedReads(llm as never, context, report, [])).toBeNull();
  });
});
