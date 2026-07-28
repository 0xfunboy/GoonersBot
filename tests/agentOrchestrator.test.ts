import { describe, expect, it, vi } from 'vitest';
import { FinalAnswerComposer } from '../src/agent/composer.js';
import { ToolOrchestrator, defineAgentTools } from '../src/agent/orchestrator.js';
import { actionLayers, validateActionPlan } from '../src/agent/planValidator.js';
import { MultiActionPlanner } from '../src/agent/planner.js';
import type { AgentToolDefinition } from '../src/agent/types.js';
import type { LLMProvider } from '../src/providers/llm/types.js';
import { fakeLLM } from './helpers.js';

const definitions: AgentToolDefinition[] = [
  {
    name: 'web_search',
    description: 'Search current public information',
    risk: 'read',
    maxCalls: 2,
  },
  {
    name: 'page_scan',
    description: 'Read and verify selected search results',
    risk: 'read',
    maxCalls: 3,
  },
  {
    name: 'image_gen',
    description: 'Create an image from a prepared brief',
    risk: 'generate',
    maxCalls: 1,
  },
];

function multiActionPlan() {
  return {
    goal: 'research a current topic and turn the verified result into a poster',
    actions: [
      {
        id: 'find_facts',
        tool: 'web_search',
        purpose: 'find current facts',
        query: 'current community event',
        acceptance: { requireOutput: true, minEvidence: 1, requiredArtifactKinds: [] },
      },
      {
        id: 'verify_sources',
        tool: 'page_scan',
        purpose: 'verify the strongest sources',
        dependsOn: ['find_facts'],
        acceptance: { requireOutput: true, minEvidence: 2, requiredArtifactKinds: [] },
      },
      {
        id: 'make_poster',
        tool: 'image_gen',
        purpose: 'make the requested poster',
        dependsOn: ['verify_sources'],
        acceptance: {
          requireOutput: true,
          minEvidence: 0,
          requiredArtifactKinds: ['image'],
        },
      },
    ],
    finalResponse: {
      language: 'Italian',
      format: 'mixed',
      mustInclude: ['verified facts', 'poster'],
      tone: 'useful and group-native',
    },
  };
}

describe('multi-action agent orchestration', () => {
  it('validates and topologically layers a multi-tool plan', () => {
    const plan = validateActionPlan(multiActionPlan(), definitions);
    expect(actionLayers(plan.actions).map((layer) => layer.map((action) => action.id))).toEqual([
      ['find_facts'],
      ['verify_sources'],
      ['make_poster'],
    ]);
  });

  it('rejects cyclic plans before executing a tool', () => {
    const cyclic = multiActionPlan();
    cyclic.actions[0] = { ...cyclic.actions[0]!, dependsOn: ['make_poster'] };
    expect(() => validateActionPlan(cyclic, definitions)).toThrow(/cycle/i);
  });

  it('executes dependencies in order and verifies evidence and artifacts', async () => {
    const trace: string[] = [];
    const registry = defineAgentTools({
      web_search: async () => {
        trace.push('search');
        return {
          summary: 'Found the current event',
          data: { urls: ['https://one.test', 'https://two.test'] },
          evidence: [{ source: 'https://one.test', claim: 'Event is current' }],
        };
      },
      page_scan: async ({ dependencies }) => {
        trace.push(`scan-after-${dependencies.has('find_facts')}`);
        return {
          summary: 'Two independent sources agree',
          evidence: [
            { source: 'https://one.test', claim: 'Fact A' },
            { source: 'https://two.test', claim: 'Fact A' },
          ],
        };
      },
      image_gen: async ({ dependencies }) => {
        trace.push(`image-after-${dependencies.has('verify_sources')}`);
        return {
          summary: 'Poster generated from the verified brief',
          artifacts: [{ kind: 'image', id: 'telegram:image:42', mime: 'image/png' }],
        };
      },
    });
    const orchestrator = new ToolOrchestrator(definitions, registry);

    const report = await orchestrator.execute(multiActionPlan(), {
      request: 'verifica la notizia e fammi un poster',
    });

    expect(report.status).toBe('complete');
    expect(report.results.map((result) => result.status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
    expect(trace).toEqual(['search', 'scan-after-true', 'image-after-true']);
  });

  it('uses the host timeout instead of an optimistic planner timeout', () => {
    const plan = validateActionPlan(
      {
        goal: 'render',
        actions: [
          {
            id: 'render',
            tool: 'image_gen',
            purpose: 'render',
            timeoutMs: 500,
          },
        ],
      },
      definitions.map((definition) =>
        definition.name === 'image_gen' ? { ...definition, timeoutMs: 420_000 } : definition,
      ),
    );
    expect(plan.actions[0]?.timeoutMs).toBe(420_000);
  });

  it('rejects artifact counts above the transport capacity', async () => {
    const constrained = definitions.map((definition) =>
      definition.name === 'image_gen'
        ? { ...definition, maxArtifactsPerKind: { image: 1 } }
        : definition,
    );
    const report = await new ToolOrchestrator(
      constrained,
      defineAgentTools({
        image_gen: async () => ({
          summary: 'made two images',
          artifacts: [
            { kind: 'image', id: 'one' },
            { kind: 'image', id: 'two' },
          ],
        }),
      }),
    ).execute(
      {
        goal: 'render',
        actions: [
          {
            id: 'render',
            tool: 'image_gen',
            purpose: 'render',
            acceptance: {
              requireOutput: true,
              minEvidence: 0,
              requiredArtifactKinds: ['image'],
            },
          },
        ],
      },
      { request: 'render' },
    );
    expect(report.results[0]?.status).toBe('failed');
    expect(report.results[0]?.error).toMatch(/transport can deliver 1/i);
  });

  it('does not pretend downstream work succeeded when verification fails', async () => {
    const image = vi.fn(async () => ({
      summary: 'should never run',
      artifacts: [{ kind: 'image' as const, id: 'x' }],
    }));
    const orchestrator = new ToolOrchestrator(
      definitions,
      defineAgentTools({
        web_search: async () => ({ summary: 'result without required evidence' }),
        page_scan: async () => ({ summary: 'should never run' }),
        image_gen: image,
      }),
    );

    const report = await orchestrator.execute(multiActionPlan(), { request: 'do it' });

    expect(report.status).toBe('failed');
    expect(report.results.map((result) => result.status)).toEqual(['failed', 'skipped', 'skipped']);
    expect(report.results[0]?.error).toMatch(/verification failed/i);
    expect(image).not.toHaveBeenCalled();
  });

  it('does not falsely claim cancellation when a tool ignores its AbortSignal', async () => {
    vi.useFakeTimers();
    try {
      const orchestrator = new ToolOrchestrator(
        definitions,
        defineAgentTools({
          web_search: async () => new Promise(() => undefined),
        }),
        { cancellationGraceMs: 50 },
      );
      const execution = orchestrator.execute(
        {
          goal: 'bounded lookup',
          actions: [
            {
              id: 'lookup',
              tool: 'web_search',
              purpose: 'bounded lookup',
              timeoutMs: 500,
            },
          ],
        },
        { request: 'look this up' },
      );

      await vi.advanceTimersByTimeAsync(551);
      const report = await execution;
      expect(report.results[0]?.status).toBe('failed');
      expect(report.results[0]?.error).toMatch(/did not confirm/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a timeout only after a cooperative tool has stopped', async () => {
    vi.useFakeTimers();
    try {
      const orchestrator = new ToolOrchestrator(
        definitions,
        defineAgentTools({
          web_search: async ({ signal }) =>
            await new Promise((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => reject(signal.reason ?? new Error('aborted')),
                { once: true },
              );
            }),
        }),
      );
      const execution = orchestrator.execute(
        {
          goal: 'bounded lookup',
          actions: [
            {
              id: 'lookup',
              tool: 'web_search',
              purpose: 'bounded lookup',
              timeoutMs: 500,
            },
          ],
        },
        { request: 'look this up' },
      );

      await vi.advanceTimersByTimeAsync(501);
      const report = await execution;
      expect(report.results[0]?.status).toBe('timed_out');
      expect(report.results[0]?.error).toMatch(/timed out/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the LLM plan multiple calls but enforces the runtime tool allow-list', async () => {
    const candidate = multiActionPlan();
    const planner = new MultiActionPlanner(fakeLLM({ json: candidate }), {
      enabled: true,
      model: 'planner',
    });

    const plan = await planner.plan({
      request: 'cerca, verifica e crea il poster',
      availableTools: definitions,
      recentMessages: [{ handle: 'alice', text: 'usiamo lo stile viola della chat' }],
    });
    expect(plan.actions.map((action) => action.tool)).toEqual([
      'web_search',
      'page_scan',
      'image_gen',
    ]);

    const unavailable = new MultiActionPlanner(fakeLLM({ json: candidate }), {
      enabled: true,
    });
    const honestFallback = await unavailable.plan({
      request: 'crea il poster',
      availableTools: definitions.filter((definition) => definition.name !== 'image_gen'),
    });
    expect(honestFallback.actions).toEqual([]);
  });

  it('compiles the Cortex intent into a dependency DAG when JSON planning fails', async () => {
    const planner = new MultiActionPlanner(fakeLLM({}), { enabled: true });
    const plan = await planner.plan({
      request: 'traduci questo in spagnolo e mandamelo vocale',
      availableTools: [
        { name: 'translate', description: 'translate text', risk: 'compute', maxCalls: 2 },
        { name: 'tts', description: 'make a voice note', risk: 'generate', maxCalls: 1 },
      ],
      requestedActions: [
        {
          tool: 'translate',
          args: { targetLanguage: 'Spanish' },
          reason: 'translate the supplied text',
        },
        { tool: 'tts', reason: 'deliver the translation as audio' },
      ],
    });
    expect(plan.actions.map((action) => action.tool)).toEqual(['translate', 'tts']);
    expect(plan.actions[1]?.dependsOn).toEqual(['translate_1']);
    expect(plan.actions[1]?.acceptance.requiredArtifactKinds).toEqual(['audio']);
  });

  it('feeds a document through translation and then TTS in the deterministic fallback DAG', async () => {
    const planner = new MultiActionPlanner(fakeLLM({}), { enabled: true });
    const plan = await planner.plan({
      request: 'leggi il PDF, traducilo in inglese e mandamelo vocale',
      availableTools: [
        { name: 'document_read', description: 'read document', risk: 'compute', maxCalls: 1 },
        { name: 'translate', description: 'translate text', risk: 'compute', maxCalls: 2 },
        { name: 'tts', description: 'make a voice note', risk: 'generate', maxCalls: 1 },
      ],
      requestedActions: [
        { tool: 'document_read', reason: 'read the attached PDF' },
        { tool: 'translate', args: { targetLanguage: 'English' }, reason: 'translate it' },
        { tool: 'tts', reason: 'deliver the translation as audio' },
      ],
    });

    expect(plan.actions.map((action) => action.tool)).toEqual([
      'document_read',
      'translate',
      'tts',
    ]);
    expect(plan.actions[1]?.dependsOn).toEqual(['document_read_1']);
    expect(plan.actions[2]?.dependsOn).toEqual(['translate_1']);
  });

  it('rejects schema-valid planning that silently drops trusted requested deliverables', async () => {
    const planner = new MultiActionPlanner(
      fakeLLM({
        json: {
          goal: 'answer something about the attachment',
          actions: [
            {
              id: 'search_instead',
              tool: 'web_search',
              purpose: 'search the web instead of reading the attachment',
              query: 'generic PDF summary',
            },
          ],
        },
      }),
      { enabled: true },
    );
    const plan = await planner.plan({
      request: 'leggi il PDF, traducilo in inglese e mandamelo vocale',
      availableTools: [
        { name: 'document_read', description: 'read document', risk: 'compute', maxCalls: 1 },
        { name: 'translate', description: 'translate text', risk: 'compute', maxCalls: 2 },
        { name: 'tts', description: 'make a voice note', risk: 'generate', maxCalls: 1 },
        { name: 'web_search', description: 'search the web', risk: 'read', maxCalls: 2 },
      ],
      requestedActions: [
        { tool: 'document_read', reason: 'read the attached PDF' },
        { tool: 'translate', args: { targetLanguage: 'English' }, reason: 'translate it' },
        { tool: 'tts', reason: 'deliver the translation as audio' },
      ],
    });

    expect(plan.actions.map((action) => action.tool)).toEqual([
      'document_read',
      'translate',
      'tts',
    ]);
    expect(plan.actions[1]?.dependsOn).toEqual(['document_read_1']);
    expect(plan.actions[2]?.dependsOn).toEqual(['translate_1']);
  });

  it('rejects schema-valid transformation plans that sever trusted document dataflow', async () => {
    const planner = new MultiActionPlanner(
      fakeLLM({
        json: {
          goal: 'read, translate and speak',
          actions: [
            {
              id: 'read_it',
              tool: 'document_read',
              purpose: 'read the attached PDF',
            },
            {
              id: 'translate_it',
              tool: 'translate',
              purpose: 'translate something',
              args: { targetLanguage: 'English' },
              dependsOn: [],
            },
            {
              id: 'speak_it',
              tool: 'tts',
              purpose: 'make a voice note',
              dependsOn: [],
            },
          ],
        },
      }),
      { enabled: true },
    );
    const plan = await planner.plan({
      request: 'leggi il PDF, traducilo in inglese e mandamelo vocale',
      availableTools: [
        { name: 'document_read', description: 'read document', risk: 'compute', maxCalls: 1 },
        { name: 'translate', description: 'translate text', risk: 'compute', maxCalls: 2 },
        { name: 'tts', description: 'make a voice note', risk: 'generate', maxCalls: 1 },
      ],
      requestedActions: [
        { tool: 'document_read', reason: 'read the attached PDF' },
        { tool: 'translate', args: { targetLanguage: 'English' }, reason: 'translate it' },
        { tool: 'tts', reason: 'deliver the translation as audio' },
      ],
    });

    expect(plan.actions.map((action) => action.tool)).toEqual([
      'document_read',
      'translate',
      'tts',
    ]);
    expect(plan.actions[1]?.dependsOn).toEqual(['document_read_1']);
    expect(plan.actions[2]?.dependsOn).toEqual(['translate_1']);
  });

  it('composes one answer and strips invented action provenance', async () => {
    const report = await new ToolOrchestrator(
      definitions,
      defineAgentTools({
        web_search: async () => ({
          summary: 'Found one reliable fact',
          evidence: [{ source: 'https://one.test', claim: 'Fact A' }],
        }),
        page_scan: async () => ({
          summary: 'Verified Fact A twice',
          evidence: [
            { source: 'https://one.test', claim: 'Fact A' },
            { source: 'https://two.test', claim: 'Fact A' },
          ],
        }),
        image_gen: async () => ({
          summary: 'Created the poster',
          artifacts: [{ kind: 'image', id: 'image-1' }],
        }),
      }),
    ).execute(multiActionPlan(), { request: 'verify and make it' });

    const llm = fakeLLM({
      json: {
        message: 'Fatto: dato verificato e poster pronto.',
        usedActionIds: ['find_facts', 'verify_sources', 'make_poster', 'invented_action'],
        uncertainties: [],
      },
    }) as LLMProvider;
    const answer = await new FinalAnswerComposer(llm).compose(report, {
      request: 'verify and make it',
    });

    expect(answer.message).toContain('poster pronto');
    expect(answer.usedActionIds).not.toContain('invented_action');
    expect(answer.evidence).toHaveLength(2);
    expect(answer.artifacts).toEqual([expect.objectContaining({ id: 'image-1' })]);
    expect(answer.verified).toBe(true);
  });
});
