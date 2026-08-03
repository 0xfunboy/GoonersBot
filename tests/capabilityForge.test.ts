import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityForge } from '../src/capabilities/forge.js';
import type { GroundingService } from '../src/search/groundingService.js';
import { fakeLLM } from './helpers.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('CapabilityForge', () => {
  it('installs, executes and reloads a persistent read-only research recipe', async () => {
    const storePath = await mkdtemp(join(tmpdir(), 'gooner-cap-'));
    tempDirs.push(storePath);
    const llm = fakeLLM({
      json: {
        classification: 'research_recipe',
        id: 'package_freshness',
        command: 'pkgfresh',
        description: 'Check the current release and support status of a software package.',
        searchQueryTemplate: 'official {input} latest release support',
        answerInstruction: 'Give the current version and cite the supplied URLs.',
        requiredConfig: [],
        reason: 'This is a reusable read-only current-information lookup.',
      },
    });
    llm.chatCompletion = async () => ({
      text: 'Versione corrente verificata.',
      usage: { inputTokens: 10, outputTokens: 4, estimated: false },
      model: 'fake',
    });
    const grounding = {
      enabled: true,
      groundWeb: async (query: string) => ({
        kind: 'web',
        block: `official result for ${query}`,
        query,
        sources: ['https://example.test/official'],
      }),
    } as unknown as GroundingService;

    const forge = new CapabilityForge(llm, grounding, {
      enabled: true,
      storePath,
      autoInstallResearch: true,
    });
    const acquired = await forge.acquire({
      request: 'controlla la versione attuale di frobnicator',
      language: 'italian',
      allowInstall: true,
    });
    expect(acquired).toMatchObject({
      handled: true,
      installed: true,
      status: 'installed',
      command: 'pkgfresh',
      text: 'Versione corrente verificata.',
    });
    expect(await readFile(join(storePath, 'package_freshness.json'), 'utf8')).toContain(
      '"kind": "research_recipe"',
    );

    const reloaded = new CapabilityForge(llm, grounding, {
      enabled: true,
      storePath,
      autoInstallResearch: true,
    });
    await reloaded.initialize();
    await expect(
      reloaded.executeCommand({
        command: '/pkgfresh',
        input: 'frobnicator',
        language: 'italian',
      }),
    ).resolves.toMatchObject({ handled: true, text: 'Versione corrente verificata.' });
  });

  it('does not reuse a capability just because generic research words overlap', async () => {
    const storePath = await mkdtemp(join(tmpdir(), 'gooner-cap-'));
    tempDirs.push(storePath);
    const plans = [
      {
        classification: 'research_recipe',
        id: 'bitcoin_euro_price',
        command: 'btcprice',
        description: 'Check the current Bitcoin price in euros from public sources.',
        searchQueryTemplate: 'official {input}',
        answerInstruction: 'Report the sourced current price.',
        requiredConfig: [],
        reason: 'Reusable read-only price research.',
      },
      {
        classification: 'research_recipe',
        id: 'ethereum_euro_price',
        command: 'ethprice',
        description: 'Check the current Ethereum price in euros from public sources.',
        searchQueryTemplate: 'official {input}',
        answerInstruction: 'Report the sourced current price.',
        requiredConfig: [],
        reason: 'A different reusable read-only price research workflow.',
      },
    ];
    let planIndex = 0;
    const llm = fakeLLM({});
    const jsonCompletion = vi.fn(async (request) => {
      const value = plans[Math.min(planIndex, plans.length - 1)];
      planIndex += 1;
      const parsed = request.schema.safeParse(value);
      return parsed.success ? parsed.data : null;
    });
    llm.jsonCompletion = jsonCompletion;
    llm.chatCompletion = async () => ({
      text: 'Prezzo verificato dalle fonti.',
      usage: { inputTokens: 3, outputTokens: 3, estimated: false },
      model: 'fake',
    });
    const forge = new CapabilityForge(
      llm,
      {
        enabled: true,
        groundWeb: async (query: string) => ({
          kind: 'web',
          block: `source for ${query}`,
          query,
          sources: ['https://example.test/price'],
        }),
      } as unknown as GroundingService,
      { enabled: true, storePath, autoInstallResearch: true },
    );

    const first = await forge.acquire({
      request: 'verifica il prezzo aggiornato di Bitcoin in euro',
      language: 'italian',
      allowInstall: true,
    });
    const second = await forge.acquire({
      request: 'verifica il prezzo aggiornato di Ethereum in euro',
      language: 'italian',
      allowInstall: true,
    });

    expect(first).toMatchObject({ status: 'installed', command: 'btcprice' });
    expect(second).toMatchObject({ status: 'installed', command: 'ethprice' });
    expect(jsonCompletion).toHaveBeenCalledTimes(2);
    expect(forge.list().map((manifest) => manifest.command)).toEqual(['btcprice', 'ethprice']);
  });

  it.each([
    [
      'Italian dependency refusal',
      'Ho trovato come si fa, ma mi serve un token prima di continuare.',
    ],
    [
      'English evidence refusal',
      'The supplied sources contain insufficient evidence to answer this request.',
    ],
  ])('does not install after a non-empty %s synthesis', async (_caseName, synthesis) => {
    const storePath = await mkdtemp(join(tmpdir(), 'gooner-cap-'));
    tempDirs.push(storePath);
    const llm = fakeLLM({
      json: {
        classification: 'research_recipe',
        id: 'refusing_lookup',
        command: 'refusinglookup',
        description: 'Research current source-backed package release information.',
        searchQueryTemplate: 'official {input}',
        answerInstruction: 'Answer from the supplied current sources.',
        requiredConfig: [],
        reason: 'A reusable read-only current-information lookup.',
      },
    });
    llm.chatCompletion = async () => ({
      text: synthesis,
      usage: { inputTokens: 4, outputTokens: 8, estimated: false },
      model: 'fake',
    });
    const forge = new CapabilityForge(
      llm,
      {
        enabled: true,
        groundWeb: async (query: string) => ({
          kind: 'web',
          block: `source for ${query}`,
          query,
          sources: ['https://example.test/release'],
        }),
      } as unknown as GroundingService,
      { enabled: true, storePath, autoInstallResearch: true },
    );

    const result = await forge.acquire({
      request: 'verifica la release corrente di Refusinator',
      language: 'italian',
      allowInstall: true,
    });

    expect(result).toMatchObject({
      handled: false,
      status: 'validation_failed',
      diagnostic: { code: 'smoke_test_failed' },
    });
    expect(result.text).toContain('non è riuscito');
    expect(forge.list()).toEqual([]);
    expect((await readdir(storePath)).filter((name) => name.endsWith('.json'))).toEqual([]);
    expect(await readFile(join(storePath, 'proposals/refusing_lookup.json'), 'utf8')).toContain(
      '"status": "validation_failed"',
    );
  });

  it('saves external integrations as proposals without pretending to execute them', async () => {
    const storePath = await mkdtemp(join(tmpdir(), 'gooner-cap-'));
    tempDirs.push(storePath);
    const forge = new CapabilityForge(
      fakeLLM({
        json: {
          classification: 'external_integration',
          id: 'calendar_writer',
          command: 'calendaradd',
          description: 'Create a calendar event in the configured account.',
          searchQueryTemplate: '{input}',
          answerInstruction: '',
          requiredConfig: ['CALENDAR_API_TOKEN'],
          reason: 'It writes to an authenticated external account.',
        },
      }),
      { enabled: false } as GroundingService,
      { enabled: true, storePath, autoInstallResearch: true },
    );
    const result = await forge.acquire({
      request: 'aggiungi un evento al calendario',
      language: 'italian',
      allowInstall: true,
    });
    expect(result.handled).toBe(false);
    expect(result.status).toBe('proposal_saved');
    expect(result.diagnostic).toEqual({
      code: 'external_integration_required',
      requirements: ['CALENDAR_API_TOKEN'],
      requirementsVerified: false,
      retryable: false,
    });
    expect(result.text).toContain('NON è una capacità installata');
    expect(result.text).toContain('non ancora verificata');
    expect(result.text).toContain('CALENDAR_API_TOKEN');
    expect(await readFile(join(storePath, 'proposals/calendar_writer.json'), 'utf8')).toContain(
      '"classification": "external_integration"',
    );
  });

  it('classifies bot media-pipeline fixes before planning or grounding and saves only a proposal', async () => {
    const storePath = await mkdtemp(join(tmpdir(), 'gooner-cap-'));
    tempDirs.push(storePath);
    const llm = fakeLLM({
      json: {
        classification: 'not_a_capability_gap',
        id: 'ordinary_answer',
        command: 'ordinary',
        description: 'Treat the request as an ordinary answer.',
        searchQueryTemplate: '{input}',
        answerInstruction: 'Answer normally.',
        requiredConfig: [],
        reason: 'No capability gap.',
      },
    });
    const planner = vi.spyOn(llm, 'jsonCompletion');
    const groundWeb = vi.fn(async (query: string) => ({
      kind: 'web' as const,
      block: `irrelevant documentation for ${query}`,
      query,
      sources: ['https://platform.openai.com/docs/irrelevant'],
    }));
    const forge = new CapabilityForge(
      llm,
      { enabled: true, groundWeb } as unknown as GroundingService,
      { enabled: true, storePath, autoInstallResearch: true },
    );
    const request =
      "Non è vero, l'unico problema è la lunghezza over quota 5 min che è il tuo limite di download: o li ignori e non dai risposta, oppure prendi 3 immagini al 20%, 50% e 70% e le aggiungi al contesto con transcript e commenti.";

    const result = await forge.acquire({
      request,
      language: 'italian',
      allowInstall: true,
    });

    expect(result).toMatchObject({
      handled: false,
      status: 'proposal_saved',
      diagnostic: { code: 'local_automation_required' },
      sources: [],
    });
    expect(planner).not.toHaveBeenCalled();
    expect(groundWeb).not.toHaveBeenCalled();
    expect(forge.list()).toEqual([]);

    const proposals = await readdir(join(storePath, 'proposals'));
    expect(proposals).toHaveLength(1);
    const proposal = JSON.parse(
      await readFile(join(storePath, 'proposals', proposals[0]!), 'utf8'),
    ) as Record<string, unknown>;
    expect(proposal).toMatchObject({
      classification: 'local_automation',
      request,
      status: 'requires_implementation',
      documentationSources: [],
    });
  });

  it('does not ground or attach incidental sources to a not-applicable request', async () => {
    const storePath = await mkdtemp(join(tmpdir(), 'gooner-cap-'));
    tempDirs.push(storePath);
    const groundWeb = vi.fn(async (query: string) => ({
      kind: 'web' as const,
      block: `irrelevant documentation for ${query}`,
      query,
      sources: ['https://platform.openai.com/docs/irrelevant'],
    }));
    const forge = new CapabilityForge(
      fakeLLM({
        json: {
          classification: 'not_a_capability_gap',
          id: 'one_off_joke',
          command: 'oneoffjoke',
          description: 'Tell one joke in the current conversation.',
          searchQueryTemplate: '{input}',
          answerInstruction: 'Answer normally.',
          requiredConfig: [],
          reason: 'This is a one-off conversational request.',
        },
      }),
      { enabled: true, groundWeb } as unknown as GroundingService,
      { enabled: true, storePath, autoInstallResearch: true },
    );

    const result = await forge.acquire({
      request: 'raccontami una barzelletta una volta sola',
      language: 'italian',
      allowInstall: true,
    });

    expect(result).toMatchObject({ handled: false, status: 'not_applicable', sources: [] });
    expect(groundWeb).not.toHaveBeenCalled();
  });

  it('installs and verifies an explicitly read-only research request when the planner returns null', async () => {
    const storePath = await mkdtemp(join(tmpdir(), 'gooner-cap-'));
    tempDirs.push(storePath);
    const llm = fakeLLM({});
    llm.chatCompletion = async () => ({
      text: 'Release verificata con le fonti.',
      usage: { inputTokens: 4, outputTokens: 4, estimated: false },
      model: 'fake',
    });
    const forge = new CapabilityForge(
      llm,
      {
        enabled: true,
        groundWeb: async (query: string) => ({
          kind: 'web',
          block: `source for ${query}`,
          query,
          sources: ['https://example.test/release'],
        }),
      } as unknown as GroundingService,
      { enabled: true, storePath, autoInstallResearch: true },
    );

    const result = await forge.acquire({
      request: 'cerca e verifica la release corrente di Frobnicator',
      language: 'italian',
      allowInstall: true,
    });

    expect(result).toMatchObject({ handled: true, installed: true, status: 'installed' });
    expect(result.command).toMatch(/^research_/);
    expect(forge.hasCommand(result.command ?? '')).toBe(true);
    expect((await readdir(storePath)).filter((name) => name.endsWith('.json'))).toHaveLength(1);
  });

  it('uses the safe research fallback after a transient planner exception', async () => {
    const storePath = await mkdtemp(join(tmpdir(), 'gooner-cap-'));
    tempDirs.push(storePath);
    const llm = fakeLLM({});
    llm.jsonCompletion = async () => {
      throw new Error('planner timeout');
    };
    llm.chatCompletion = async () => ({
      text: 'Risultato verificato.',
      usage: { inputTokens: 2, outputTokens: 2, estimated: false },
      model: 'fake',
    });
    const forge = new CapabilityForge(
      llm,
      {
        enabled: true,
        groundWeb: async (query: string) => ({
          kind: 'web',
          block: `source for ${query}`,
          query,
          sources: ['https://example.test/current'],
        }),
      } as unknown as GroundingService,
      { enabled: true, storePath, autoInstallResearch: true },
    );

    await expect(
      forge.acquire({
        request: 'monitora le notizie aggiornate su Frobnicator',
        language: 'italian',
        allowInstall: true,
      }),
    ).resolves.toMatchObject({ handled: true, installed: true, status: 'installed' });
  });

  it('treats explicit reusable research as learnable even if the planner calls it normal reasoning', async () => {
    const storePath = await mkdtemp(join(tmpdir(), 'gooner-cap-'));
    tempDirs.push(storePath);
    const llm = fakeLLM({
      json: {
        classification: 'not_a_capability_gap',
        id: 'ordinary_answer',
        command: 'ordinary',
        description: 'Answer this as an ordinary conversational request.',
        searchQueryTemplate: '{input}',
        answerInstruction: 'Answer normally.',
        requiredConfig: [],
        reason: 'The base model could answer one example.',
      },
    });
    llm.chatCompletion = async () => ({
      text: 'Rassegna verificata.',
      usage: { inputTokens: 2, outputTokens: 2, estimated: false },
      model: 'fake',
    });
    const forge = new CapabilityForge(
      llm,
      {
        enabled: true,
        groundWeb: async (query: string) => ({
          kind: 'web',
          block: `source for ${query}`,
          query,
          sources: ['https://example.test/news'],
        }),
      } as unknown as GroundingService,
      { enabled: true, storePath, autoInstallResearch: true },
    );

    await expect(
      forge.acquire({
        request: 'crea una rassegna delle notizie aggiornate su Frobnicator',
        language: 'italian',
        allowInstall: true,
      }),
    ).resolves.toMatchObject({ handled: true, installed: true, status: 'installed' });
  });

  it('never coerces a download or credential workflow into the local research fallback', async () => {
    const storePath = await mkdtemp(join(tmpdir(), 'gooner-cap-'));
    tempDirs.push(storePath);
    const forge = new CapabilityForge(
      fakeLLM({}),
      {
        enabled: true,
        groundWeb: async (query: string) => ({
          kind: 'web',
          block: `source for ${query}`,
          query,
          sources: ['https://example.test/docs'],
        }),
      } as unknown as GroundingService,
      { enabled: true, storePath, autoInstallResearch: true },
    );

    const result = await forge.acquire({
      request: 'cerca come fare login e scarica i video usando password e cookie',
      language: 'italian',
      allowInstall: true,
    });

    expect(result).toMatchObject({
      handled: false,
      status: 'planning_failed',
      diagnostic: { code: 'planner_unavailable', retryable: true },
    });
    expect(forge.list()).toEqual([]);
    expect((await readdir(storePath)).filter((name) => name.endsWith('.json'))).toEqual([]);
  });

  it('reports the actual missing dependency and saves the research plan without publishing it', async () => {
    const storePath = await mkdtemp(join(tmpdir(), 'gooner-cap-'));
    tempDirs.push(storePath);
    const forge = new CapabilityForge(
      fakeLLM({
        json: {
          classification: 'research_recipe',
          id: 'offline_research',
          command: 'offlinecheck',
          description: 'Research current package information from public sources.',
          searchQueryTemplate: 'official {input}',
          answerInstruction: 'Summarize only supplied source evidence.',
          requiredConfig: [],
          reason: 'A reusable read-only research workflow.',
        },
      }),
      { enabled: false } as GroundingService,
      { enabled: true, storePath, autoInstallResearch: true },
    );

    const result = await forge.acquire({
      request: 'verifica la versione corrente del pacchetto',
      language: 'italian',
      allowInstall: true,
    });

    expect(result).toMatchObject({
      handled: false,
      status: 'blocked_dependency',
      diagnostic: {
        code: 'web_grounding_unavailable',
        requirements: ['WEB_SEARCH_ENABLED', 'SEARXNG_URL'],
        requirementsVerified: true,
        retryable: false,
      },
    });
    expect(forge.hasCommand('offlinecheck')).toBe(false);
    expect(await readFile(join(storePath, 'proposals/offline_research.json'), 'utf8')).toContain(
      '"status": "blocked_dependency"',
    );
  });

  it('never exposes or executes a persisted capability that collides with a static route', async () => {
    const storePath = await mkdtemp(join(tmpdir(), 'gooner-cap-'));
    tempDirs.push(storePath);
    const llm = fakeLLM({});
    llm.chatCompletion = async () => ({
      text: 'should not execute',
      usage: { inputTokens: 1, outputTokens: 1, estimated: false },
      model: 'fake',
    });
    await writeFile(
      join(storePath, 'colliding_help.json'),
      JSON.stringify({
        version: 1,
        id: 'colliding_help',
        command: 'help',
        description: 'A stale generated route colliding with static help.',
        kind: 'research_recipe',
        searchQueryTemplate: '{input} official',
        answerInstruction: 'Answer only from supplied current sources.',
        createdFrom: 'legacy test fixture',
        createdAt: new Date().toISOString(),
        enabled: true,
      }),
    );
    const forge = new CapabilityForge(
      llm,
      {
        enabled: true,
        groundWeb: async () => ({
          kind: 'web',
          block: 'source',
          query: 'query',
          sources: [],
        }),
      } as unknown as GroundingService,
      { enabled: true, storePath, autoInstallResearch: true },
    );
    await forge.initialize();
    forge.reserveCommands(['help']);

    expect(forge.hasCommand('help')).toBe(false);
    expect(forge.list()).toEqual([]);
    await expect(
      forge.executeCommand({ command: 'help', input: 'x', language: 'italian' }),
    ).resolves.toBeNull();
  });

  it('keeps manifest IDs unique independently from command collisions and never overwrites files', async () => {
    const storePath = await mkdtemp(join(tmpdir(), 'gooner-cap-'));
    tempDirs.push(storePath);
    const sentinel = '{"legacy":"must survive"}\n';
    await writeFile(join(storePath, 'shared_identity.json'), sentinel);

    const plans = [
      {
        classification: 'research_recipe',
        id: 'shared_identity',
        command: 'sharedcmd',
        description: 'Research current Martian atmospheric weather evidence.',
        searchQueryTemplate: 'official mars weather {input}',
        answerInstruction: 'Summarize only the supplied scientific evidence.',
        requiredConfig: [],
        reason: 'A reusable read-only evidence lookup.',
      },
      {
        classification: 'research_recipe',
        id: 'shared_identity',
        command: 'sharedcmd',
        description: 'Research current Dutch tulip market quotations.',
        searchQueryTemplate: 'official tulip market {input}',
        answerInstruction: 'Summarize only the supplied market evidence.',
        requiredConfig: [],
        reason: 'A separate reusable read-only lookup.',
      },
    ];
    let planIndex = 0;
    const llm = fakeLLM({});
    llm.jsonCompletion = async (request) => {
      const value = plans[Math.min(planIndex, plans.length - 1)];
      planIndex += 1;
      const parsed = request.schema.safeParse(value);
      return parsed.success ? parsed.data : null;
    };
    llm.chatCompletion = async () => ({
      text: 'Smoke verificato.',
      usage: { inputTokens: 3, outputTokens: 2, estimated: false },
      model: 'fake',
    });
    const forge = new CapabilityForge(
      llm,
      {
        enabled: true,
        groundWeb: async (query: string) => ({
          kind: 'web',
          block: `source for ${query}`,
          query,
          sources: ['https://example.test/source'],
        }),
      } as unknown as GroundingService,
      { enabled: true, storePath, autoInstallResearch: true },
    );

    const first = await forge.acquire({
      request: 'trova meteo marziano aggiornato',
      language: 'italian',
      allowInstall: true,
    });
    const second = await forge.acquire({
      request: 'verifica quotazione tulipani olandesi',
      language: 'italian',
      allowInstall: true,
    });

    expect(first).toMatchObject({
      capabilityId: 'shared_identity_2',
      command: 'sharedcmd',
      installed: true,
    });
    expect(second).toMatchObject({
      capabilityId: 'shared_identity_3',
      command: 'sharedcmd_tool',
      installed: true,
    });
    expect(await readFile(join(storePath, 'shared_identity.json'), 'utf8')).toBe(sentinel);
    expect(forge.list().map(({ id, command }) => ({ id, command }))).toEqual([
      { id: 'shared_identity_2', command: 'sharedcmd' },
      { id: 'shared_identity_3', command: 'sharedcmd_tool' },
    ]);
  });

  it('serializes concurrent installations and reuses the recipe installed by the winner', async () => {
    const storePath = await mkdtemp(join(tmpdir(), 'gooner-cap-'));
    tempDirs.push(storePath);
    const llm = fakeLLM({
      json: {
        classification: 'research_recipe',
        id: 'concurrent_lookup',
        command: 'concurrent',
        description: 'Research current concurrent package release information.',
        searchQueryTemplate: 'official package release {input}',
        answerInstruction: 'Answer from the supplied release evidence.',
        requiredConfig: [],
        reason: 'A reusable read-only release lookup.',
      },
    });
    let activeExecutions = 0;
    let maxActiveExecutions = 0;
    llm.chatCompletion = async () => {
      activeExecutions += 1;
      maxActiveExecutions = Math.max(maxActiveExecutions, activeExecutions);
      await new Promise((resolve) => setTimeout(resolve, 15));
      activeExecutions -= 1;
      return {
        text: 'Versione concorrente verificata.',
        usage: { inputTokens: 2, outputTokens: 2, estimated: false },
        model: 'fake',
      };
    };
    const forge = new CapabilityForge(
      llm,
      {
        enabled: true,
        groundWeb: async (query: string) => ({
          kind: 'web',
          block: `source for ${query}`,
          query,
          sources: ['https://example.test/release'],
        }),
      } as unknown as GroundingService,
      { enabled: true, storePath, autoInstallResearch: true },
    );

    const [first, second] = await Promise.all([
      forge.acquire({
        request: 'controlla concurrent package release corrente',
        language: 'italian',
        allowInstall: true,
      }),
      forge.acquire({
        request: 'controlla concurrent package release corrente',
        language: 'italian',
        allowInstall: true,
      }),
    ]);

    expect(maxActiveExecutions).toBe(1);
    expect(first).toMatchObject({
      capabilityId: 'concurrent_lookup',
      command: 'concurrent',
      installed: true,
    });
    expect(second).toMatchObject({
      capabilityId: 'concurrent_lookup',
      command: 'concurrent',
      installed: true,
    });
    expect(forge.list()).toHaveLength(1);
    expect((await readdir(storePath)).filter((name) => name.endsWith('.json'))).toEqual([
      'concurrent_lookup.json',
    ]);
  });

  it('does not publish a recipe and persists an actionable diagnostic when smoke fails', async () => {
    const storePath = await mkdtemp(join(tmpdir(), 'gooner-cap-'));
    tempDirs.push(storePath);
    const llm = fakeLLM({
      json: {
        classification: 'research_recipe',
        id: 'broken_lookup',
        command: 'brokenlookup',
        description: 'Research a current source-backed result that may fail.',
        searchQueryTemplate: 'official {input}',
        answerInstruction: 'Answer only from supplied current sources.',
        requiredConfig: [],
        reason: 'A reusable read-only lookup.',
      },
    });
    llm.chatCompletion = async () => {
      throw new Error('smoke execution exploded');
    };
    const forge = new CapabilityForge(
      llm,
      {
        enabled: true,
        groundWeb: async (query: string) => ({
          kind: 'web',
          block: `source for ${query}`,
          query,
          sources: ['https://example.test/source'],
        }),
      } as unknown as GroundingService,
      { enabled: true, storePath, autoInstallResearch: true },
    );

    const result = await forge.acquire({
      request: 'crea una ricerca che fallisce al collaudo',
      language: 'italian',
      allowInstall: true,
    });
    expect(result).toMatchObject({
      handled: false,
      status: 'validation_failed',
      diagnostic: { code: 'smoke_test_failed', retryable: true },
    });
    expect(forge.hasCommand('brokenlookup')).toBe(false);
    expect(forge.list()).toEqual([]);
    expect((await readdir(storePath)).filter((name) => name.endsWith('.json'))).toEqual([]);
    expect(await readFile(join(storePath, 'proposals/broken_lookup.json'), 'utf8')).toContain(
      '"status": "validation_failed"',
    );
  });

  it('rolls back installation when the request is aborted during smoke execution', async () => {
    const storePath = await mkdtemp(join(tmpdir(), 'gooner-cap-'));
    tempDirs.push(storePath);
    const controller = new AbortController();
    const llm = fakeLLM({
      json: {
        classification: 'research_recipe',
        id: 'aborted_lookup',
        command: 'abortedlookup',
        description: 'Research a current source-backed result with cancellation.',
        searchQueryTemplate: 'official {input}',
        answerInstruction: 'Answer only from supplied current sources.',
        requiredConfig: [],
        reason: 'A reusable cancellable read-only lookup.',
      },
    });
    llm.chatCompletion = async (request) => {
      controller.abort(new Error('cancelled during smoke'));
      throw request.signal?.reason ?? new Error('missing cancellation');
    };
    const forge = new CapabilityForge(
      llm,
      {
        enabled: true,
        groundWeb: async (query: string) => ({
          kind: 'web',
          block: `source for ${query}`,
          query,
          sources: ['https://example.test/source'],
        }),
      } as unknown as GroundingService,
      { enabled: true, storePath, autoInstallResearch: true },
    );

    await expect(
      forge.acquire({
        request: 'crea una ricerca annullabile',
        language: 'italian',
        allowInstall: true,
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled during smoke');
    expect(forge.hasCommand('abortedlookup')).toBe(false);
    expect((await readdir(storePath)).filter((name) => name.endsWith('.json'))).toEqual([]);
  });

  it('persists colliding proposals under unique IDs without overwriting the first', async () => {
    const storePath = await mkdtemp(join(tmpdir(), 'gooner-cap-'));
    tempDirs.push(storePath);
    const forge = new CapabilityForge(
      fakeLLM({
        json: {
          classification: 'external_integration',
          id: 'shared_proposal',
          command: 'externalwrite',
          description: 'Write a value to an authenticated external service.',
          searchQueryTemplate: '{input}',
          answerInstruction: '',
          requiredConfig: ['EXTERNAL_API_TOKEN'],
          reason: 'It writes to an authenticated external account.',
        },
      }),
      { enabled: false } as GroundingService,
      { enabled: true, storePath, autoInstallResearch: true },
    );

    await forge.acquire({
      request: 'scrivi il primo valore esterno',
      language: 'italian',
      allowInstall: true,
    });
    const first = await readFile(join(storePath, 'proposals/shared_proposal.json'), 'utf8');
    await forge.acquire({
      request: 'scrivi il secondo valore esterno',
      language: 'italian',
      allowInstall: true,
    });
    const second = await readFile(join(storePath, 'proposals/shared_proposal_2.json'), 'utf8');

    expect(first).toContain('"id": "shared_proposal"');
    expect(first).toContain('scrivi il primo valore esterno');
    expect(await readFile(join(storePath, 'proposals/shared_proposal.json'), 'utf8')).toBe(first);
    expect(second).toContain('"id": "shared_proposal_2"');
    expect(second).toContain('scrivi il secondo valore esterno');
  });
});
