import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { LLMProvider } from '../providers/llm/types.js';
import type { GroundingService } from '../search/groundingService.js';
import { childLogger } from '../utils/logger.js';
import { throwIfAborted } from '../utils/abort.js';
import {
  capabilityManifestSchema,
  capabilityPlanSchema,
  isVerifiedCapabilityExecution,
  type CapabilityDiagnostic,
  type CapabilityExecution,
  type CapabilityManifest,
  type CapabilityPlan,
} from './types.js';

const log = childLogger('capability-forge');

export interface CapabilityForgeConfig {
  enabled: boolean;
  storePath: string;
  autoInstallResearch: boolean;
}

export interface CapabilityForgeStatus {
  enabled: boolean;
  chatModelReady: boolean;
  webGroundingReady: boolean;
  autoInstallResearch: boolean;
  installed: number;
}

/**
 * Durable extension layer for low-risk knowledge capabilities.
 *
 * A model may author a declarative research recipe, but never executable JavaScript. The recipe can
 * combine a grounded search with a constrained synthesis prompt and becomes available immediately
 * as /<command>. Requests needing credentials, writes or machine access are saved as an explicit
 * proposal instead of being falsely reported as completed.
 */
export class CapabilityForge {
  readonly enabled: boolean;
  private readonly storePath: string;
  private readonly manifests = new Map<string, CapabilityManifest>();
  private readonly manifestsById = new Map<string, CapabilityManifest>();
  private readonly reservedCommands = new Set<string>();
  private initialization: Promise<void> | null = null;
  private installationQueue: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(
    private readonly llm: LLMProvider,
    private readonly grounding: GroundingService,
    private readonly cfg: CapabilityForgeConfig,
  ) {
    this.enabled = cfg.enabled;
    this.storePath = isAbsolute(cfg.storePath)
      ? cfg.storePath
      : resolve(process.cwd(), cfg.storePath);
  }

  async initialize(): Promise<void> {
    if (this.initialized || !this.enabled) return;
    if (this.initialization) return this.initialization;
    this.initialization = this.loadManifests();
    try {
      await this.initialization;
    } catch (err) {
      this.initialization = null;
      throw err;
    }
  }

  private async loadManifests(): Promise<void> {
    await mkdir(this.storePath, { recursive: true });
    const files = (await readdir(this.storePath))
      .filter((name) => name.endsWith('.json'))
      .sort((a, b) => a.localeCompare(b));
    for (const file of files) {
      try {
        const parsed = capabilityManifestSchema.safeParse(
          JSON.parse(await readFile(join(this.storePath, file), 'utf8')),
        );
        if (parsed.success && parsed.data.enabled) {
          const commandOwner = this.manifests.get(parsed.data.command);
          const idOwner = this.manifestsById.get(parsed.data.id);
          if (commandOwner || idOwner) {
            log.warn(
              {
                file,
                id: parsed.data.id,
                command: parsed.data.command,
                conflictingId: idOwner?.id ?? commandOwner?.id,
                conflictingCommand: commandOwner?.command ?? idOwner?.command,
              },
              'duplicate capability identity ignored',
            );
            continue;
          }
          this.registerManifest(parsed.data);
        } else if (!parsed.success) {
          log.warn({ file, issues: parsed.error.issues }, 'invalid capability manifest ignored');
        }
      } catch (err) {
        log.warn({ err, file }, 'capability manifest load failed');
      }
    }
    this.initialized = true;
    log.info({ count: this.manifests.size, storePath: this.storePath }, 'capabilities loaded');
  }

  list(): CapabilityManifest[] {
    return [...this.manifests.values()]
      .filter((manifest) => !this.reservedCommands.has(manifest.command))
      .sort((a, b) => a.command.localeCompare(b.command));
  }

  status(): CapabilityForgeStatus {
    return {
      enabled: this.enabled,
      chatModelReady: this.llm.capabilities.chat,
      webGroundingReady: this.grounding.enabled,
      autoInstallResearch: this.cfg.autoInstallResearch,
      installed: this.list().length,
    };
  }

  /** Static Telegram routes/aliases can never be shadowed by a generated capability. */
  reserveCommands(commands: Iterable<string>): void {
    for (const command of commands) {
      const normalized = normalizeCommand(command);
      if (normalized) this.reservedCommands.add(normalized);
    }
  }

  /** Fast in-memory route check used before admitting a dynamic Telegram command turn. */
  hasCommand(command: string): boolean {
    const normalized = normalizeCommand(command);
    return !this.reservedCommands.has(normalized) && this.manifests.has(normalized);
  }

  async executeCommand(params: {
    command: string;
    input: string;
    language: string;
    chatId?: number;
    model?: string;
  }): Promise<CapabilityExecution | null> {
    await this.initialize();
    const normalized = normalizeCommand(params.command);
    if (this.reservedCommands.has(normalized)) return null;
    const manifest = this.manifests.get(normalized);
    if (!manifest) return null;
    const result = await this.executeManifest(
      manifest,
      params.input,
      params.language,
      params.chatId,
      params.model,
    );
    return {
      ...result,
      status: result.handled ? 'executed' : result.status,
      capabilityId: manifest.id,
      command: manifest.command,
      installed: true,
    };
  }

  async acquire(params: {
    request: string;
    language: string;
    allowInstall: boolean;
    chatId?: number;
    model?: string;
    signal?: AbortSignal;
  }): Promise<CapabilityExecution> {
    await this.initialize();
    if (!this.enabled) {
      return empty(
        params.language === 'italian'
          ? 'Capability Forge è disattivato: abilita CAPABILITY_FORGE_ENABLED.'
          : 'Capability Forge is disabled: enable CAPABILITY_FORGE_ENABLED.',
        'blocked_dependency',
        diagnostic('forge_disabled', ['CAPABILITY_FORGE_ENABLED'], false),
      );
    }
    if (!this.llm.capabilities.chat) {
      return empty(
        params.language === 'italian'
          ? 'Non posso progettare la capacità: non è configurato un modello chat.'
          : 'I cannot design the capability because no chat model is configured.',
        'blocked_dependency',
        diagnostic('chat_model_unavailable', ['LLM_MODEL'], false),
      );
    }

    // Protect local implementation requests before both planner grounding and reuse. A loosely
    // matching research recipe must not turn a bot bug report into an unrelated web lookup.
    const guardedLocalAutomationPlan = localBotAutomationPlan(params.request);
    const existing = guardedLocalAutomationPlan
      ? undefined
      : this.findLikelyExisting(params.request);
    if (existing) {
      const result = await this.executeManifest(
        existing,
        params.request,
        params.language,
        params.chatId,
        params.model,
        params.signal,
      );
      return {
        ...result,
        status: result.handled ? 'reused' : result.status,
        capabilityId: existing.id,
        command: existing.command,
        installed: true,
      };
    }

    // A request to change this bot's own behaviour is local implementation work, not a web-research
    // recipe. Classify it before any grounding so a bug report cannot spend search quota or inherit
    // unrelated API documentation merely because it was submitted through /learn.
    const localResearchPlan = fallbackResearchPlan(params.request);
    let plan: CapabilityPlan | null = guardedLocalAutomationPlan;
    if (!plan) {
      try {
        const proposed = await this.llm.jsonCompletion({
          system: [
            'You design persistent capabilities for a Telegram assistant. Output only schema JSON.',
            'The user explicitly invoked /learn. A reusable read-only web research workflow IS a',
            'capability gap even when one example could be answered by ordinary reasoning.',
            'Classify honestly. research_recipe is ONLY for read-only requests solvable by web search',
            'plus text synthesis. external_integration is for APIs/accounts/credentials or real-world',
            'writes. local_automation is for filesystem, shell, compilation or machine control.',
            'A request to fix or change this bot, its handlers, limits or media pipeline is always',
            'local_automation, never not_a_capability_gap, even if the current code partly supports it.',
            'Use not_a_capability_gap only for a one-off conversational request with no reusable',
            'research workflow. Never disguise an external write or code execution as research.',
            'Create a short stable lowercase slash command. searchQueryTemplate must contain {input}.',
          ].join('\n'),
          prompt: `USER CAPABILITY GAP:\n${params.request}\n\nDesign the smallest reusable capability.`,
          schema: capabilityPlanSchema,
          temperature: 0.1,
          ...(params.model ? { model: params.model } : {}),
          maxTokens: 1200,
          signal: params.signal,
        });
        plan = proposed ? capabilityPlanSchema.parse(proposed) : null;
      } catch (err) {
        throwIfAborted(params.signal);
        log.warn(
          { err, hasSafeFallback: Boolean(localResearchPlan) },
          'capability planning failed',
        );
        if (!localResearchPlan) {
          return empty(
            params.language === 'italian'
              ? 'Il pianificatore non è disponibile in questo momento; nessuna capacità è stata dichiarata installata.'
              : 'The planner is unavailable right now; no capability was reported as installed.',
            'planning_failed',
            diagnostic('planner_unavailable', [], true),
          );
        }
      }
    }
    const plannerReturnedNoPlan = !plan;
    if (!plan || plan.classification === 'not_a_capability_gap') {
      // `/learn` is explicit intent. If the model is unavailable or dismisses a clearly safe,
      // reusable research request, use a narrow local recipe rather than losing the acquisition.
      // Side effects, downloads, credentials and machine access never enter this fallback.
      plan = localResearchPlan;
    }
    if (!plan) {
      return empty(
        plannerReturnedNoPlan
          ? params.language === 'italian'
            ? 'Il pianificatore non ha prodotto un piano valido e la richiesta non rientra nel fallback sicuro di ricerca; nessuna capacità è stata installata.'
            : 'The planner produced no valid plan and the request is outside the safe research fallback; no capability was installed.'
          : params.language === 'italian'
            ? 'Non manca un plugin: questa richiesta va risolta dal normale ragionamento.'
            : 'This is not a capability gap; normal reasoning should handle it.',
        plannerReturnedNoPlan ? 'planning_failed' : 'not_applicable',
        plannerReturnedNoPlan ? diagnostic('planner_unavailable', [], true) : undefined,
      );
    }

    // Documentation research is useful only after an external integration has been identified.
    // Research recipes perform their own focused grounding during smoke execution; local changes
    // and not-applicable requests must never acquire incidental web sources.
    const docs =
      plan.classification === 'external_integration' && this.grounding.enabled
        ? await this.grounding
            .groundWeb(
              `official developer API documentation ${plan.description} ${params.request}`.slice(
                0,
                300,
              ),
              params.language,
              params.chatId,
              params.signal,
            )
            .catch((err) => {
              throwIfAborted(params.signal);
              log.debug({ err }, 'capability documentation research failed');
              return null;
            })
        : null;

    if (plan.classification !== 'research_recipe') {
      throwIfAborted(params.signal);
      const documentationSources =
        plan.classification === 'external_integration' ? (docs?.sources ?? []) : [];
      const proposalId = await this.persistProposal(plan.id, (uniqueId) => ({
        ...plan,
        id: uniqueId,
        command: this.availableCommand(plan.command),
        request: params.request,
        status: 'requires_implementation',
        diagnostic: diagnostic(
          plan.classification === 'external_integration'
            ? 'external_integration_required'
            : 'local_automation_required',
          plan.requiredConfig ?? [],
          false,
          false,
        ),
        documentationSources,
        createdAt: new Date(),
      }));
      const requiredConfig = plan.requiredConfig ?? [];
      const required = requiredConfig.length
        ? params.language === 'italian'
          ? ` Configurazione suggerita dal piano, non ancora verificata: ${requiredConfig.join(', ')}.`
          : ` Planner-suggested configuration, not yet verified: ${requiredConfig.join(', ')}.`
        : '';
      return withSources(
        empty(
          params.language === 'italian'
            ? `Ho salvato il progetto ${proposalId} per /${this.availableCommand(plan.command)}, ma NON è una capacità installata: richiede ${plan.classification === 'external_integration' ? "un'integrazione esterna" : 'automazione locale'} sviluppata e revisionata. /learn non genera né esegue codice arbitrario.${required}`
            : `I saved design ${proposalId} for /${this.availableCommand(plan.command)}, but it is NOT an installed capability: it needs reviewed ${plan.classification.replace('_', ' ')} implementation. /learn does not generate or execute arbitrary code.${required}`,
          'proposal_saved',
          diagnostic(
            plan.classification === 'external_integration'
              ? 'external_integration_required'
              : 'local_automation_required',
            requiredConfig,
            false,
            false,
          ),
        ),
        documentationSources,
      );
    }

    if (!this.grounding.enabled) {
      throwIfAborted(params.signal);
      const proposalId = await this.persistProposal(plan.id, (uniqueId) => ({
        ...plan,
        id: uniqueId,
        command: this.availableCommand(plan.command),
        request: params.request,
        status: 'blocked_dependency',
        diagnostic: diagnostic(
          'web_grounding_unavailable',
          ['WEB_SEARCH_ENABLED', 'SEARXNG_URL'],
          false,
        ),
        documentationSources: docs?.sources ?? [],
        createdAt: new Date(),
      }));
      return withSources(
        empty(
          params.language === 'italian'
            ? `La ricetta ${proposalId} è valida ma non installabile: il grounding web non è operativo. Configura WEB_SEARCH_ENABLED=true e SEARXNG_URL, poi rilancia /learn.`
            : `Recipe ${proposalId} is valid but cannot be installed: web grounding is unavailable. Configure WEB_SEARCH_ENABLED=true and SEARXNG_URL, then run /learn again.`,
          'blocked_dependency',
          diagnostic('web_grounding_unavailable', ['WEB_SEARCH_ENABLED', 'SEARXNG_URL'], false),
        ),
        docs?.sources ?? [],
      );
    }

    if (!params.allowInstall || !this.cfg.autoInstallResearch) {
      throwIfAborted(params.signal);
      const proposalId = await this.persistProposal(plan.id, (uniqueId) => ({
        ...plan,
        id: uniqueId,
        command: this.availableCommand(plan.command),
        request: params.request,
        status: 'awaiting_approval',
        documentationSources: docs?.sources ?? [],
        createdAt: new Date(),
      }));
      return withSources(
        empty(
          params.language === 'italian'
            ? `Ricetta proposta come ${proposalId} e salvata in attesa di approvazione admin.`
            : `Recipe proposal ${proposalId} was saved for admin approval.`,
          'awaiting_approval',
          diagnostic('auto_install_disabled', ['CAPABILITY_AUTO_INSTALL_RESEARCH'], false),
        ),
        docs?.sources ?? [],
      );
    }

    return this.serializeInstallation(async () => {
      throwIfAborted(params.signal);

      // A concurrent acquisition may have installed the same reusable recipe while this request
      // was planning. Reuse it instead of minting a duplicate ID/route.
      const installedWhileWaiting = this.findLikelyExisting(params.request);
      if (installedWhileWaiting) {
        const result = await this.executeManifest(
          installedWhileWaiting,
          params.request,
          params.language,
          params.chatId,
          params.model,
          params.signal,
        );
        return {
          ...result,
          status: result.handled ? 'reused' : result.status,
          capabilityId: installedWhileWaiting.id,
          command: installedWhileWaiting.command,
          installed: true,
        };
      }

      let command = this.availableCommand(plan.command);
      const draft: CapabilityManifest = {
        version: 1,
        id: plan.id,
        command,
        description: plan.description,
        kind: 'research_recipe',
        searchQueryTemplate: ensureInputPlaceholder(plan.searchQueryTemplate ?? '{input}'),
        answerInstruction:
          plan.answerInstruction ?? 'Answer the request precisely from the sources.',
        createdFrom: params.request.slice(0, 500),
        createdAt: new Date().toISOString(),
        enabled: true,
      };

      // This is the transaction's validation phase. The recipe must complete one real grounded
      // request before either its route or its manifest becomes durable/visible.
      throwIfAborted(params.signal);
      const smoke = await this.executeManifest(
        draft,
        params.request,
        params.language,
        params.chatId,
        params.model,
        params.signal,
      );
      throwIfAborted(params.signal);
      if (!isVerifiedCapabilityExecution(smoke) || !smoke.text.trim()) {
        log.warn(
          { id: draft.id, command: draft.command },
          'capability smoke execution failed; installation aborted',
        );
        const proposalId = await this.persistProposal(plan.id, (uniqueId) => ({
          ...plan,
          id: uniqueId,
          command: draft.command,
          request: params.request,
          status: 'validation_failed',
          diagnostic: smoke.diagnostic ?? diagnostic('smoke_test_failed', [], true),
          documentationSources: docs?.sources ?? [],
          createdAt: new Date(),
        }));
        return withSources(
          empty(
            params.language === 'italian'
              ? `Il collaudo di /${draft.command} non è riuscito (${proposalId} salvata per diagnosi): il comando non è stato pubblicato. Riprova se la ricerca o il modello erano temporaneamente indisponibili.`
              : `The /${draft.command} smoke test failed (${proposalId} saved for diagnostics), so the command was not published. Retry if search or the model was temporarily unavailable.`,
            'validation_failed',
            smoke.diagnostic ?? diagnostic('smoke_test_failed', [], true),
          ),
          smoke.sources,
        );
      }

      // reserveCommands() is synchronous but can run while the smoke request is awaiting I/O.
      // Allocate again immediately before the durable commit.
      command = this.availableCommand(plan.command);
      const committedDraft = { ...draft, command };
      let persisted: { manifest: CapabilityManifest; path: string } | null = null;
      try {
        persisted = await this.persistManifestExclusive(committedDraft);
        throwIfAborted(params.signal);
        if (
          this.reservedCommands.has(persisted.manifest.command) ||
          this.manifests.has(persisted.manifest.command) ||
          this.manifestsById.has(persisted.manifest.id)
        ) {
          throw new Error('capability identity became occupied during commit');
        }
        this.registerManifest(persisted.manifest);
      } catch (err) {
        if (persisted) await unlink(persisted.path).catch(() => undefined);
        throw err;
      }

      return {
        ...smoke,
        status: 'installed',
        capabilityId: persisted.manifest.id,
        command: persisted.manifest.command,
        installed: true,
      };
    });
  }

  private findLikelyExisting(request: string): CapabilityManifest | undefined {
    const normalizedRequest = normalizeMatchText(request);
    if (!normalizedRequest) return undefined;

    return this.list()
      .map((manifest) => ({
        manifest,
        score: capabilityRequestMatchScore(
          normalizedRequest,
          normalizeMatchText(manifest.createdFrom),
        ),
      }))
      .filter((item) => item.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.manifest.createdAt.localeCompare(b.manifest.createdAt) ||
          a.manifest.id.localeCompare(b.manifest.id),
      )[0]?.manifest;
  }

  private availableCommand(requested: string): string {
    const base = normalizeCommand(requested).slice(0, 26) || 'research';
    const occupied = (candidate: string): boolean =>
      this.reservedCommands.has(candidate) || this.manifests.has(candidate);
    if (!occupied(base)) return base;
    for (let index = 1; index <= 99; index += 1) {
      const suffix = index === 1 ? '_tool' : `_tool${index}`;
      const candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
      if (!occupied(candidate)) return candidate;
    }
    return `skill_${Date.now().toString(36).slice(-8)}`;
  }

  private async executeManifest(
    manifest: CapabilityManifest,
    input: string,
    language: string,
    chatId: number | undefined,
    model: string | undefined,
    signal?: AbortSignal,
  ): Promise<CapabilityExecution> {
    if (!this.grounding.enabled) {
      return empty(
        language === 'italian'
          ? `/${manifest.command} è installato, ma il grounding web non è configurato. Imposta WEB_SEARCH_ENABLED=true e SEARXNG_URL.`
          : `/${manifest.command} is installed, but web grounding is not configured. Set WEB_SEARCH_ENABLED=true and SEARXNG_URL.`,
        'blocked_dependency',
        diagnostic('web_grounding_unavailable', ['WEB_SEARCH_ENABLED', 'SEARXNG_URL'], false),
      );
    }
    const query = manifest.searchQueryTemplate.replaceAll('{input}', input).slice(0, 300);
    let grounded: Awaited<ReturnType<GroundingService['groundWeb']>>;
    try {
      grounded = await this.grounding.groundWeb(query, language, chatId, signal);
    } catch (err) {
      throwIfAborted(signal);
      log.warn({ err, id: manifest.id, command: manifest.command }, 'capability grounding failed');
      return empty(
        language === 'italian'
          ? `/${manifest.command} non può interrogare le fonti in questo momento. Riprova più tardi.`
          : `/${manifest.command} cannot query sources right now. Try again later.`,
        'validation_failed',
        diagnostic('web_grounding_no_results', [], true),
      );
    }
    if (!grounded) {
      return empty(
        language === 'italian'
          ? `/${manifest.command} non ha trovato fonti sufficienti o ha esaurito la quota di ricerca.`
          : `/${manifest.command} found no sufficient sources or exhausted its search quota.`,
        'validation_failed',
        diagnostic('web_grounding_no_results', [], true),
      );
    }
    let completion: Awaited<ReturnType<LLMProvider['chatCompletion']>>;
    try {
      completion = await this.llm.chatCompletion({
        system: [
          'Execute a read-only research capability. Use only the supplied source context for current',
          'claims. Never claim external actions. If evidence is missing, say so precisely.',
          `Reply in ${language}. ${manifest.answerInstruction}`,
        ].join('\n'),
        messages: [
          {
            role: 'user',
            content: `REQUEST:\n${input}\n\nSOURCE CONTEXT:\n${grounded.block}`,
          },
        ],
        ...(model ? { model } : {}),
        temperature: 0.25,
        maxTokens: 1800,
        signal,
      });
    } catch (err) {
      throwIfAborted(signal);
      log.warn({ err, id: manifest.id, command: manifest.command }, 'capability synthesis failed');
      return empty(
        language === 'italian'
          ? `/${manifest.command} ha trovato le fonti, ma il modello non ha completato la sintesi. Riprova più tardi.`
          : `/${manifest.command} found sources, but the model did not complete synthesis. Try again later.`,
        'validation_failed',
        diagnostic('smoke_test_failed', [], true),
      );
    }
    const text = completion.text.trim();
    if (!text) {
      return empty(
        language === 'italian'
          ? `/${manifest.command} ha ricevuto una sintesi vuota dal modello. Riprova più tardi.`
          : `/${manifest.command} received an empty synthesis from the model. Try again later.`,
        'validation_failed',
        diagnostic('smoke_test_failed', [], true),
      );
    }
    if (isCapabilitySynthesisRefusal(text)) {
      return withSources(
        empty(
          language === 'italian'
            ? `/${manifest.command} non ha prodotto una risposta verificabile dalle fonti: il risultato segnala un rifiuto, dati insufficienti o una dipendenza mancante.`
            : `/${manifest.command} did not produce a source-verifiable answer: the result reports a refusal, insufficient evidence, or a missing dependency.`,
          'validation_failed',
          diagnostic('smoke_test_failed', [], true),
        ),
        grounded.sources,
      );
    }
    return {
      handled: true,
      text,
      status: 'executed',
      usage: {
        inputTokens: completion.usage.inputTokens ?? 0,
        outputTokens: completion.usage.outputTokens ?? 0,
        estimated: completion.usage.estimated,
      },
      model: completion.model,
      sources: grounded.sources,
    };
  }

  private registerManifest(manifest: CapabilityManifest): void {
    if (this.manifests.has(manifest.command) || this.manifestsById.has(manifest.id)) {
      throw new Error(`duplicate capability identity: ${manifest.id}/${manifest.command}`);
    }
    this.manifests.set(manifest.command, manifest);
    this.manifestsById.set(manifest.id, manifest);
  }

  private serializeInstallation<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.installationQueue.then(operation);
    this.installationQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private async persistManifestExclusive(
    manifest: CapabilityManifest,
  ): Promise<{ manifest: CapabilityManifest; path: string }> {
    await mkdir(this.storePath, { recursive: true });
    for (let index = 0; index < 10_000; index += 1) {
      const id = numberedIdentifier(manifest.id, index, 49);
      if (this.manifestsById.has(id)) continue;
      const validated = capabilityManifestSchema.parse({ ...manifest, id });
      const target = join(this.storePath, `${validated.id}.json`);
      try {
        await atomicCreateJson(target, validated);
        return { manifest: validated, path: target };
      } catch (err) {
        if (isAlreadyExists(err)) continue;
        throw err;
      }
    }
    throw new Error(`could not allocate a unique manifest ID for ${manifest.id}`);
  }

  private async persistProposal(
    id: string,
    proposal: (uniqueId: string) => unknown,
  ): Promise<string> {
    const proposals = join(this.storePath, 'proposals');
    await mkdir(proposals, { recursive: true });
    for (let index = 0; index < 10_000; index += 1) {
      const uniqueId = numberedIdentifier(id, index, 49);
      try {
        await atomicCreateJson(join(proposals, `${uniqueId}.json`), proposal(uniqueId));
        return uniqueId;
      } catch (err) {
        if (isAlreadyExists(err)) continue;
        throw err;
      }
    }
    throw new Error(`could not allocate a unique proposal ID for ${id}`);
  }
}

function normalizeCommand(command: string): string {
  return command.replace(/^\//, '').split('@', 1)[0]?.toLowerCase() ?? '';
}

function ensureInputPlaceholder(template: string): string {
  return template.includes('{input}') ? template : `${template} {input}`.trim();
}

function numberedIdentifier(base: string, index: number, maxLength: number): string {
  if (index === 0) return base.slice(0, maxLength);
  const suffix = `_${index + 1}`;
  return `${base.slice(0, maxLength - suffix.length)}${suffix}`;
}

async function atomicCreateJson(target: string, value: unknown): Promise<void> {
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;

    // A hard-link publishes the fully-written inode in one operation and fails with EEXIST rather
    // than replacing an existing manifest/proposal.
    await link(temp, target);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
  }
}

function isAlreadyExists(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'EEXIST';
}

function empty(
  text: string,
  status: CapabilityExecution['status'],
  reason?: CapabilityDiagnostic,
): CapabilityExecution {
  return {
    handled: false,
    text,
    status,
    ...(reason ? { diagnostic: reason } : {}),
    usage: { inputTokens: 0, outputTokens: 0, estimated: true },
    model: null,
    sources: [],
  };
}

function withSources(result: CapabilityExecution, sources: string[]): CapabilityExecution {
  return { ...result, sources: [...new Set(sources)] };
}

function diagnostic(
  code: CapabilityDiagnostic['code'],
  requirements: string[],
  retryable: boolean,
  requirementsVerified = true,
): CapabilityDiagnostic {
  return {
    code,
    requirements: [...new Set(requirements)],
    requirementsVerified,
    retryable,
  };
}

const CAPABILITY_MATCH_STOP_WORDS = new Set([
  'about',
  'aggiornata',
  'aggiornate',
  'aggiornati',
  'aggiornato',
  'attuale',
  'attuali',
  'capability',
  'cerca',
  'cercare',
  'check',
  'comando',
  'controlla',
  'controllare',
  'corrente',
  'correnti',
  'crea',
  'create',
  'dalla',
  'dalle',
  'della',
  'delle',
  'dello',
  'find',
  'latest',
  'oggi',
  'prezzo',
  'price',
  'ricerca',
  'research',
  'search',
  'stato',
  'status',
  'trova',
  'trovare',
  'verifica',
  'verificare',
  'with',
]);

function normalizeMatchText(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.join(' ')
      .trim() ?? ''
  );
}

function capabilityRequestMatchScore(normalizedRequest: string, normalizedOrigin: string): number {
  if (!normalizedOrigin) return 0;
  // Exact requests (ignoring case, accents and punctuation) are safe to reuse, including very
  // short topic names. Paraphrases have to agree on nearly all distinctive terms.
  if (normalizedRequest === normalizedOrigin) return 1;

  const requestTerms = significantCapabilityTerms(normalizedRequest);
  const originTerms = significantCapabilityTerms(normalizedOrigin);
  if (requestTerms.size < 2 || originTerms.size < 2) return 0;
  const shared = [...requestTerms].filter((term) => originTerms.has(term)).length;
  if (shared < 2) return 0;
  const requestCoverage = shared / requestTerms.size;
  const originCoverage = shared / originTerms.size;
  if (requestCoverage < 0.8 || originCoverage < 0.8) return 0;
  return (requestCoverage + originCoverage) / 2;
}

function significantCapabilityTerms(normalized: string): Set<string> {
  return new Set(
    normalized
      .split(' ')
      .filter((term) => term.length >= 3 && !CAPABILITY_MATCH_STOP_WORDS.has(term)),
  );
}

const CAPABILITY_SYNTHESIS_REFUSAL_PATTERNS = [
  /\b(?:as an ai|as a language model)\b/u,
  /\b(?:i cannot|i can t|i am unable|i m unable|i do not have access|i don t have access)\b/u,
  /\b(?:non posso|non riesco|non sono in grado|non ho accesso|non dispongo)\b/u,
  /\b(?:missing|requires?|needs?)\s+(?:an?\s+|the\s+)?(?:api key|token|credentials?|configuration|dependency|authentication)\b/u,
  /\b(?:manca(?:no)?|serve|servono|richiede)\s+(?:una?\s+|le?\s+)?(?:chiave api|api key|token|credenzial\w*|configurazion\w*|dipendenz\w*|autenticazion\w*)\b/u,
  /\b(?:insufficient|not enough|no sufficient|missing)\s+(?:source|sources|evidence|information|data)\b/u,
  /\b(?:source|sources|evidence|information|data)\s+(?:is|are|was|were)?\s*(?:insufficient|missing|unavailable)\b/u,
  /\b(?:source|sources|evidence|information|data)(?:\s+\w+){0,4}\s+(?:insufficient|missing|unavailable)\b/u,
  /\b(?:fonti|evidenze|informazioni|dati)\s+(?:non\s+sono\s+|sono\s+)?(?:insufficienti|mancanti|assenti|indisponibili)\b/u,
  /\bnon (?:ci sono|ho) (?:abbastanza|sufficienti) (?:fonti|evidenze|informazioni|dati)\b/u,
];

/** Reject a non-empty synthesis that is only a refusal or a missing-dependency/no-evidence note. */
function isCapabilitySynthesisRefusal(text: string): boolean {
  const normalized = normalizeMatchText(text);
  return CAPABILITY_SYNTHESIS_REFUSAL_PATTERNS.some((pattern) => pattern.test(normalized));
}

const RESEARCH_INTENT_RE =
  /\b(ricerc|cerca|trov|verific|controll|monitor|confront|riassum|rassegna|notizi|aggiorn|documentaz|paper|release|prezz|quotaz|meteo|research|search|find|check|verify|monitor|compare|summari[sz]|news|documentation|weather|price)\w*/iu;
const NON_RESEARCH_ACTION_RE =
  /\b(scaric|download|caric|upload|pubblic|post(?:a|are|ing)?|invi|send|scriv|write|modific|edit|elimin|delete|compra|buy|vend|sell|prenot|book|login|acced|autentic|credential|password|cookie|token|api\s*key|shell|terminale|filesystem|file\s+system|compil|install|esegu|execute|run\s+(?:a\s+)?command|deploy|wallet|transaz|bonific|payment|pagament|scrap(?:e|ing)|crawler)\w*/iu;
const GENERATED_AUTOMATION_RE =
  /\b(crea|costruisc|svilupp|implement|create|build|develop)\w*(?:\s+\w+){0,5}\s+(bot|script|client|plugin|app)\b/iu;
const BOT_CHANGE_ACTION_RE =
  /\b(corregg|sistem|fix|modific|cambi|implement|aggiung|rimuov|gestisc|support|ignor|prend|usa|includ|fai\s+in\s+modo)\w*/iu;
const BOT_SYSTEM_TARGET_RE =
  /\b(bot|gooneurobot|goonersbot|pipeline|handler|extractor|downloader|rehost|link[ _-]?media)\w*/iu;
const BOT_SELF_REFERENCE_RE = /\b(tu[oaie]|your|its)\b/iu;
const BOT_PIPELINE_SIGNAL_RE =
  /\b(download|quota|limit|limite|transcript|trascriz|contesto|context|frame|immagin|comment|video|reel)\w*/giu;
const FALLBACK_STOP_WORDS = new Set([
  'aggiornato',
  'attuale',
  'cerca',
  'cercare',
  'check',
  'controlla',
  'confronta',
  'della',
  'delle',
  'dello',
  'documentazione',
  'find',
  'latest',
  'monitorare',
  'notizie',
  'official',
  'ricerca',
  'search',
  'trova',
  'verifica',
  'with',
]);

/**
 * Deterministic safety guard for explicit requests to modify this bot's local behaviour. These
 * become reviewable proposals only: they never enter the research-recipe installer and never run
 * generated code.
 */
function localBotAutomationPlan(request: string): CapabilityPlan | null {
  const normalized = request.trim();
  const pipelineSignals = new Set(
    (normalized.match(BOT_PIPELINE_SIGNAL_RE) ?? []).map((signal) => signal.toLowerCase()),
  );
  const identifiesBotOrPipeline =
    BOT_SYSTEM_TARGET_RE.test(normalized) ||
    (BOT_SELF_REFERENCE_RE.test(normalized) && pipelineSignals.size > 0) ||
    pipelineSignals.size > 1;
  if (normalized.length < 8 || !BOT_CHANGE_ACTION_RE.test(normalized) || !identifiesBotOrPipeline) {
    return null;
  }

  const target =
    normalized
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .match(
        /\b(quota|download|rehost|link[ _-]?media|transcript|context|contesto|frame|comment|video|reel|pipeline|handler|bot)\w*/,
      )?.[0]
      ?.replace(/[^a-z0-9]+/g, '_')
      .slice(0, 20) ?? 'pipeline';
  const command = `fix_${target}`.slice(0, 31);
  return capabilityPlanSchema.parse({
    classification: 'local_automation',
    id: `${command}_automation`.slice(0, 49),
    command,
    description: `Reviewed local bot behaviour change: ${normalized}`.slice(0, 240),
    searchQueryTemplate: '{input}',
    answerInstruction: '',
    requiredConfig: [],
    reason:
      'The request changes local bot or media-pipeline behaviour and requires a reviewed code change.',
  });
}

/**
 * Last-resort planner for an explicit, obviously read-only research workflow. It deliberately
 * refuses anything that resembles credentials, downloads, side effects or machine execution.
 * The resulting recipe still has to pass the normal live grounding+synthesis smoke test.
 */
function fallbackResearchPlan(request: string): CapabilityPlan | null {
  const normalized = request.trim();
  if (
    normalized.length < 8 ||
    !RESEARCH_INTENT_RE.test(normalized) ||
    NON_RESEARCH_ACTION_RE.test(normalized) ||
    GENERATED_AUTOMATION_RE.test(normalized)
  ) {
    return null;
  }

  const words = normalized
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((word) => word.length >= 3 && !FALLBACK_STOP_WORDS.has(word))
    .slice(0, 3);
  const topic = words?.join('_').slice(0, 23) || 'web';
  const command = normalizeCommand(`research_${topic}`).slice(0, 31);
  return capabilityPlanSchema.parse({
    classification: 'research_recipe',
    id: `${command}_recipe`.slice(0, 49),
    command,
    description: `Ricerca web verificata e riutilizzabile: ${normalized}`.slice(0, 240),
    searchQueryTemplate: '{input}',
    answerInstruction:
      'Answer only from the supplied current sources, distinguish facts from uncertainty, and include the source URLs.',
    requiredConfig: [],
    reason: 'Explicit reusable read-only research request; deterministic safe fallback.',
  });
}
