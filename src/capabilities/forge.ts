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
  type CapabilityExecution,
  type CapabilityManifest,
} from './types.js';

const log = childLogger('capability-forge');

export interface CapabilityForgeConfig {
  enabled: boolean;
  storePath: string;
  autoInstallResearch: boolean;
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
    return { ...result, capabilityId: manifest.id, command: manifest.command, installed: true };
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
    if (!this.enabled) return empty('Capability Forge is disabled.');

    const existing = this.findLikelyExisting(params.request);
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
        capabilityId: existing.id,
        command: existing.command,
        installed: true,
      };
    }

    const docs = this.grounding.enabled
      ? await this.grounding
          .groundWeb(
            `official developer API documentation ${params.request}`.slice(0, 300),
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
    const plan = await this.llm.jsonCompletion({
      system: [
        'You design persistent capabilities for a Telegram assistant. Output only schema JSON.',
        'Classify honestly. research_recipe is ONLY for read-only requests solvable by web search',
        'plus text synthesis. external_integration is for APIs/accounts/credentials or real-world',
        'writes. local_automation is for filesystem, shell, compilation or machine control.',
        'Never disguise an external write or code execution as a research recipe.',
        'Create a short stable lowercase slash command. searchQueryTemplate must contain {input}.',
      ].join('\n'),
      prompt: [
        `USER CAPABILITY GAP:\n${params.request}`,
        docs ? `\nOFFICIAL-DOC RESEARCH CONTEXT:\n${docs.block}` : '',
        '\nDesign the smallest reusable capability.',
      ].join('\n'),
      schema: capabilityPlanSchema,
      temperature: 0.1,
      ...(params.model ? { model: params.model } : {}),
      maxTokens: 1200,
      signal: params.signal,
    });
    if (!plan || plan.classification === 'not_a_capability_gap') {
      return withSources(
        empty(
          params.language === 'italian'
            ? 'Non manca un plugin: questa richiesta va risolta dal normale ragionamento.'
            : 'This is not a capability gap; normal reasoning should handle it.',
        ),
        docs?.sources ?? [],
      );
    }

    if (plan.classification !== 'research_recipe') {
      throwIfAborted(params.signal);
      const proposalId = await this.persistProposal(plan.id, (uniqueId) => ({
        ...plan,
        id: uniqueId,
        command: this.availableCommand(plan.command),
        request: params.request,
        documentationSources: docs?.sources ?? [],
        createdAt: new Date(),
      }));
      const requiredConfig = plan.requiredConfig ?? [];
      const required = requiredConfig.length
        ? ` Configurazione richiesta: ${requiredConfig.join(', ')}.`
        : '';
      return withSources(
        empty(
          params.language === 'italian'
            ? `Ho progettato la proposta ${proposalId} per /${this.availableCommand(plan.command)}, ma richiede ${plan.classification === 'external_integration' ? "un'integrazione esterna" : 'automazione locale'}: non eseguo codice generato o azioni reali alla cieca.${required} Proposta salvata, nessuna finta esecuzione.`
            : `I saved proposal ${proposalId} for /${this.availableCommand(plan.command)}, but it needs ${plan.classification.replace('_', ' ')}. I will not blindly execute generated code or real-world actions.${required} Nothing was falsely reported as done.`,
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
        documentationSources: docs?.sources ?? [],
        createdAt: new Date(),
      }));
      return withSources(
        empty(
          params.language === 'italian'
            ? `Ricetta proposta come ${proposalId} e salvata in attesa di approvazione admin.`
            : `Recipe proposal ${proposalId} was saved for admin approval.`,
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
      if (!smoke.handled || !smoke.text.trim()) {
        log.warn(
          { id: draft.id, command: draft.command },
          'capability smoke execution failed; installation aborted',
        );
        return withSources(
          empty(
            params.language === 'italian'
              ? `Il collaudo di /${draft.command} non ha prodotto una risposta valida: non ho installato né pubblicato il comando.`
              : `The /${draft.command} smoke test did not produce a valid answer, so the command was not installed or published.`,
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
        capabilityId: persisted.manifest.id,
        command: persisted.manifest.command,
        installed: true,
      };
    });
  }

  private findLikelyExisting(request: string): CapabilityManifest | undefined {
    const terms = new Set(
      request
        .toLowerCase()
        .split(/[^\p{L}\p{N}_]+/u)
        .filter((x) => x.length > 3),
    );
    return this.list()
      .map((manifest) => ({
        manifest,
        score: [...terms].filter((term) =>
          `${manifest.description} ${manifest.createdFrom}`.toLowerCase().includes(term),
        ).length,
      }))
      .sort((a, b) => b.score - a.score)
      .find((item) => item.score >= 2)?.manifest;
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
      );
    }
    const query = manifest.searchQueryTemplate.replaceAll('{input}', input).slice(0, 300);
    const grounded = await this.grounding.groundWeb(query, language, chatId, signal);
    if (!grounded) {
      return empty(
        language === 'italian'
          ? `/${manifest.command} non ha trovato fonti sufficienti o ha esaurito la quota di ricerca.`
          : `/${manifest.command} found no sufficient sources or exhausted its search quota.`,
      );
    }
    const completion = await this.llm.chatCompletion({
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
    return {
      handled: true,
      text: completion.text.trim(),
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

function empty(text: string): CapabilityExecution {
  return {
    handled: false,
    text,
    usage: { inputTokens: 0, outputTokens: 0, estimated: true },
    model: null,
    sources: [],
  };
}

function withSources(result: CapabilityExecution, sources: string[]): CapabilityExecution {
  return { ...result, sources: [...new Set(sources)] };
}
