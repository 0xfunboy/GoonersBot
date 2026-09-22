import { describe, expect, it } from 'vitest';
import { agentToolNameSchema } from '../src/agent/schemas.js';
import { cortexToolEnum } from '../src/brain/cortex/schema.js';
import { buildCortexPrompt } from '../src/brain/cortex/prompt.js';
import {
  BUILTIN_CAPABILITY_IDS,
  CORTEX_CAPABILITY_IDS,
  RUNTIME_CAPABILITY_MANIFESTS,
  assertCapabilityHandlerCoverage,
  capabilitySnapshot,
  isTerminalCapability,
  validateCapabilityInvocation,
} from '../src/companion/capabilities/catalog.js';

describe('runtime capability catalog', () => {
  it('is the single identity source for Cortex and the planner', () => {
    expect(agentToolNameSchema.options).toEqual(BUILTIN_CAPABILITY_IDS);
    expect(cortexToolEnum.options).toEqual(CORTEX_CAPABILITY_IDS);
    expect(new Set(BUILTIN_CAPABILITY_IDS).size).toBe(BUILTIN_CAPABILITY_IDS.length);
    expect(BUILTIN_CAPABILITY_IDS).toContain('page_scan');
    expect(BUILTIN_CAPABILITY_IDS.filter((id) => id === 'page_scan')).toHaveLength(1);

    for (const id of CORTEX_CAPABILITY_IDS) {
      expect(RUNTIME_CAPABILITY_MANIFESTS[id].cortexVisible).toBe(true);
    }
  });

  it('declares typed operations, effects and retry boundaries for every capability', () => {
    for (const manifest of Object.values(RUNTIME_CAPABILITY_MANIFESTS)) {
      expect(manifest.version).toBe(1);
      expect(manifest.operations.length).toBeGreaterThan(0);
      expect(new Set(manifest.operations.map((operation) => operation.id)).size).toBe(
        manifest.operations.length,
      );
      for (const operation of manifest.operations) {
        const args =
          manifest.id === 'anime_archive'
            ? { intent: 'search' }
            : manifest.id === 'workflow'
              ? { intent: operation.id }
              : manifest.id === 'capability_forge' && operation.id === 'execute'
                ? { command: 'papers' }
                : { operation: operation.id };
        expect(operation.inputSchema.safeParse({ query: 'request', args }).success).toBe(true);
        expect(
          operation.outputSchema.safeParse({
            summary: 'verified result',
            verified: true,
            sources: [],
            artifacts: [],
          }).success,
        ).toBe(true);
      }
    }
    expect(
      RUNTIME_CAPABILITY_MANIFESTS.anime_knowledge.operations.map((item) => item.effect),
    ).toEqual(['read', 'write', 'delete']);
    expect(
      RUNTIME_CAPABILITY_MANIFESTS.anime_archive.operations.find((item) => item.id === 'rehost'),
    ).toMatchObject({ effect: 'send', retry: 'never_blindly' });
  });

  it('fails closed when an advertised capability has no executable handler', () => {
    expect(() => assertCapabilityHandlerCoverage(['web_search'], {})).toThrow(
      'Runtime capability handler missing: web_search',
    );
    expect(() =>
      assertCapabilityHandlerCoverage(['web_search'], { web_search: async () => undefined }),
    ).not.toThrow();
  });

  it('validates model-authored operation inputs before handler execution', () => {
    expect(validateCapabilityInvocation('page_scan', { args: {} })).toContain(
      'args.url: page_scan.audit requires a public URL in query or args.url',
    );
    expect(
      validateCapabilityInvocation('anime_archive', {
        query: 'Tanya the Evil 2',
        args: { intent: 'rehost', episode: '7' },
      }),
    ).toEqual([]);
    expect(
      validateCapabilityInvocation('anime_archive', { args: { intent: 'invented' } }).join(' '),
    ).toContain('unknown operation invented');
  });

  it('produces timestamped readiness snapshots and terminal routing from the manifests', () => {
    const checkedAt = new Date('2026-09-19T00:00:00.000Z');
    const snapshot = capabilitySnapshot(
      {
        page_scan: { state: 'ready' },
        video_gen: { state: 'needs_configuration', reason: 'missing provider' },
      },
      checkedAt,
    );
    expect(snapshot.find((item) => item.id === 'page_scan')).toMatchObject({
      readiness: 'ready',
      reason: null,
      checkedAt: checkedAt.toISOString(),
    });
    expect(snapshot.find((item) => item.id === 'video_gen')).toMatchObject({
      readiness: 'needs_configuration',
      reason: 'missing provider',
    });
    expect(isTerminalCapability('page_scan')).toBe(true);
    expect(isTerminalCapability('news')).toBe(false);
  });

  it('places an installed recipe in the natural-language Cortex prompt', () => {
    const prompt = buildCortexPrompt({
      currentMessage: 'cercami i paper recenti sui transformer',
      availableTools: ['capability_forge'],
      availableCapabilityDetails: [
        'capability_forge installed recipe: command=papers; Search technical papers.',
      ],
      history: [],
      scene: {
        currentTopic: 'technical papers',
        energy: 'normal',
        userIntent: 'question',
        botIsBeingCriticized: false,
      },
      botIsAddressed: true,
      recentNegativeFeedback: false,
    });
    expect(prompt).toContain('command=papers');
    expect(prompt).toContain('Search technical papers');
  });
});
