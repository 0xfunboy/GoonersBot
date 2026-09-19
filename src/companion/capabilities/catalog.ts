import { z } from 'zod';

export const BUILTIN_CAPABILITY_IDS = [
  'group_rag',
  'knowledge_rag',
  'anime_knowledge',
  'anime_archive',
  'web_search',
  'page_scan',
  'news',
  'image_lookup',
  'document_read',
  'document_create',
  'data_analysis',
  'workflow',
  'companion_memory',
  'connected_service',
  'code_work',
  'media_prompt',
  'image_gen',
  'video_gen',
  'music',
  'link_media',
  'translate',
  'tts',
  'capability_forge',
] as const;

export const CORTEX_CAPABILITY_IDS = [
  'companion_memory',
  'connected_service',
  'code_work',
  'data_analysis',
  'workflow',
  'document_create',
  'web_search',
  'page_scan',
  'news',
  'image_lookup',
  'group_rag',
  'knowledge_rag',
  'anime_knowledge',
  'anime_archive',
  'music',
  'link_media',
  'image_gen',
  'video_gen',
  'translate',
  'tts',
  'capability_forge',
] as const;

export type BuiltinCapabilityId = (typeof BUILTIN_CAPABILITY_IDS)[number];
export type CortexCapabilityId = (typeof CORTEX_CAPABILITY_IDS)[number];
export type CapabilityEffect =
  | 'read'
  | 'compute'
  | 'generate'
  | 'draft'
  | 'write'
  | 'send'
  | 'publish'
  | 'delete';
export type CapabilityReadiness =
  | 'installed'
  | 'disabled'
  | 'needs_configuration'
  | 'ready'
  | 'degraded'
  | 'unavailable';
export type CapabilityRisk = 'read' | 'compute' | 'generate' | 'external_write';
export type CapabilityArtifactKind = 'image' | 'video' | 'audio' | 'document' | 'link' | 'text';

const operationInputSchema = z
  .object({
    query: z.string().min(1).max(2_000).optional(),
    args: z.record(z.unknown()).default({}),
  })
  .strict();

const pageAuditInputSchema = operationInputSchema.superRefine((value, ctx) => {
  const url = typeof value.args['url'] === 'string' ? value.args['url'].trim() : '';
  if (!url && !value.query?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['args', 'url'],
      message: 'page_scan.audit requires a public URL in query or args.url',
    });
  }
});

const animeArchiveInputSchema = operationInputSchema.superRefine((value, ctx) => {
  const title = typeof value.args['title'] === 'string' ? value.args['title'].trim() : '';
  const intent = typeof value.args['intent'] === 'string' ? value.args['intent'] : '';
  if (!['search', 'availability', 'rehost', 'series'].includes(intent)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['args', 'intent'],
      message: 'anime_archive requires search, availability, rehost or series intent',
    });
  }
  if (intent !== 'search' && !title && !value.query?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['args', 'title'],
      message: 'anime archive operation requires a concrete title',
    });
  }
});

const workflowInputSchema = operationInputSchema.superRefine((value, ctx) => {
  if (!['create', 'list', 'update', 'cancel'].includes(String(value.args['intent']))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['args', 'intent'],
      message: 'workflow requires create, list, update or cancel intent',
    });
  }
});

const operationOutputSchema = z
  .object({
    summary: z.string().min(1).max(12_000),
    verified: z.boolean(),
    sources: z.array(z.string().min(1).max(2_000)).max(20).default([]),
    artifacts: z
      .array(
        z.object({
          kind: z.enum(['image', 'video', 'audio', 'document', 'link', 'text']),
          id: z.string().min(1).max(2_000),
        }),
      )
      .max(20)
      .default([]),
  })
  .strict();

export interface RuntimeCapabilityOperationManifest {
  id: string;
  description: string;
  examples: readonly string[];
  effect: CapabilityEffect;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  requiredReferents: readonly string[];
  idempotency: 'none' | 'effect_key' | 'provider_receipt';
  retry: 'safe' | 'checkpoint_only' | 'never_blindly';
}

export interface RuntimeCapabilityManifest {
  id: BuiltinCapabilityId;
  version: 1;
  description: string;
  examples: readonly string[];
  operations: readonly RuntimeCapabilityOperationManifest[];
  adapterRisk: CapabilityRisk;
  cortexVisible: boolean;
  terminal: boolean;
  requirements: readonly string[];
  resourceClass: 'interactive' | 'network' | 'media' | 'browser' | 'generation';
  defaultTimeoutMs: number;
  defaultMaxCalls: number;
  outputKinds: readonly CapabilityArtifactKind[];
  legacyProviderId: string;
  /** Selected read operations acquire factual evidence, rather than only control/social context. */
  groundsClaims?: boolean;
}

type ManifestSeed = Omit<RuntimeCapabilityManifest, 'id' | 'version' | 'operations'> & {
  operations: ReadonlyArray<
    Omit<RuntimeCapabilityOperationManifest, 'inputSchema' | 'outputSchema'>
  >;
};

const operation = (
  id: string,
  description: string,
  effect: CapabilityEffect,
  examples: readonly string[],
  options: Pick<
    RuntimeCapabilityOperationManifest,
    'requiredReferents' | 'idempotency' | 'retry'
  > = { requiredReferents: [], idempotency: 'none', retry: 'safe' },
): ManifestSeed['operations'][number] => ({ id, description, effect, examples, ...options });

const seeds: Record<BuiltinCapabilityId, ManifestSeed> = {
  companion_memory: {
    description:
      'Remember, recall, correct, export or forget the requester’s scoped personal and project memories, with provenance and erasure fences.',
    examples: [
      'ricorda questa decisione per il progetto',
      'cosa ricordi di me?',
      'dimentica questa preferenza',
    ],
    operations: ['remember', 'recall', 'list', 'correct', 'export', 'forget'].map((id) =>
      operation(
        id,
        `${id} scoped memory`,
        ['recall', 'list', 'export'].includes(id) ? 'read' : id === 'forget' ? 'delete' : 'write',
        [],
        { requiredReferents: [], idempotency: 'effect_key', retry: 'checkpoint_only' },
      ),
    ),
    adapterRisk: 'compute',
    cortexVisible: true,
    terminal: true,
    requirements: ['accepted terms', 'immutable actor scope'],
    resourceClass: 'interactive',
    defaultTimeoutMs: 20_000,
    defaultMaxCalls: 3,
    outputKinds: ['text', 'document'],
    legacyProviderId: 'companion_memory',
  },
  connected_service: {
    description:
      'Use the configured Telegram bot connection: scoped metadata, message drafts, delegated sends, access inspection and revocation. Not a personal Telegram account.',
    examples: [
      'prepara una bozza per questa chat',
      'autorizzo gli invii in questa conversazione',
      'revoca la delega',
    ],
    operations: ['list', 'read', 'draft', 'send', 'grant', 'revoke'].map((id) =>
      operation(
        id,
        `${id} current-chat connection`,
        id === 'send'
          ? 'send'
          : id === 'grant'
            ? 'write'
            : id === 'revoke'
              ? 'delete'
              : id === 'draft'
                ? 'draft'
                : 'read',
        [],
        { requiredReferents: [], idempotency: 'effect_key', retry: 'never_blindly' },
      ),
    ),
    adapterRisk: 'compute',
    cortexVisible: true,
    terminal: true,
    requirements: ['configured Telegram connection', 'exact delegation'],
    resourceClass: 'network',
    defaultTimeoutMs: 30_000,
    defaultMaxCalls: 2,
    outputKinds: ['text'],
    legacyProviderId: 'connected_service',
  },
  code_work: {
    description:
      'Review public GitHub repository sources and prepare an apply-checked patch without running repository code. For the configured local repository, authorized admin private chats can prepare patch/tests, inspect status/diff or cancel. No automatic apply or deployment.',
    examples: [
      'prepara una correzione del repository configurato',
      'fammi vedere la patch',
      'annulla la modifica',
    ],
    operations: ['review', 'propose', 'status', 'diff', 'cancel'].map((id) =>
      operation(
        id,
        `${id} isolated code work`,
        id === 'review'
          ? 'generate'
          : id === 'propose'
            ? 'write'
            : id === 'cancel'
              ? 'delete'
              : 'read',
        [],
        { requiredReferents: [], idempotency: 'effect_key', retry: 'checkpoint_only' },
      ),
    ),
    adapterRisk: 'compute',
    cortexVisible: true,
    terminal: true,
    requirements: [
      'public GitHub repository and chat model for review',
      'authorized admin private chat and configured worker for local development',
    ],
    resourceClass: 'interactive',
    defaultTimeoutMs: 130_000,
    defaultMaxCalls: 1,
    outputKinds: ['text', 'document'],
    legacyProviderId: 'code_work',
  },
  group_rag: {
    description: 'Recall relevant community members, relationships and group lore.',
    examples: ['ricordati cosa avevamo deciso', 'chi è coinvolto in questa storia?'],
    operations: [
      operation('recall', 'Recall scoped group context.', 'read', ['ricorda il contesto']),
    ],
    adapterRisk: 'read',
    cortexVisible: true,
    terminal: false,
    requirements: ['accepted terms', 'visible chat scope'],
    resourceClass: 'interactive',
    defaultTimeoutMs: 15_000,
    defaultMaxCalls: 1,
    outputKinds: ['text'],
    legacyProviderId: 'group_rag',
  },
  knowledge_rag: {
    groundsClaims: true,
    description: 'Retrieve stable curated technical and cultural knowledge.',
    examples: ['cosa sappiamo già di questo?', 'cerca nella base di conoscenza'],
    operations: [
      operation('lookup', 'Look up curated knowledge.', 'read', ['consulta la knowledge base']),
    ],
    adapterRisk: 'read',
    cortexVisible: true,
    terminal: false,
    requirements: ['knowledge index'],
    resourceClass: 'interactive',
    defaultTimeoutMs: 20_000,
    defaultMaxCalls: 2,
    outputKinds: ['text'],
    legacyProviderId: 'knowledge_rag',
  },
  anime_knowledge: {
    description: 'Look up anime metadata and manage per-chat release follows.',
    examples: ['quando esce il prossimo episodio?', 'seguimi questa serie', 'smetti di seguirla'],
    operations: [
      operation('lookup', 'Read catalog metadata and release state.', 'read', ['quando esce?']),
      operation('follow', 'Create or update a chat follow.', 'write', ['avvisami quando esce'], {
        requiredReferents: ['anime title'],
        idempotency: 'effect_key',
        retry: 'safe',
      }),
      operation('unfollow', 'Remove a chat follow.', 'delete', ['non seguirlo più'], {
        requiredReferents: ['anime follow'],
        idempotency: 'effect_key',
        retry: 'safe',
      }),
    ],
    adapterRisk: 'read',
    cortexVisible: true,
    terminal: false,
    requirements: ['anime catalog'],
    resourceClass: 'network',
    defaultTimeoutMs: 30_000,
    defaultMaxCalls: 2,
    outputKinds: ['text'],
    legacyProviderId: 'anime_knowledge',
  },
  anime_archive: {
    description:
      'Resolve supported archive sources and prepare or queue verified Telegram rehosts.',
    examples: ['trova episodio 7 su AnimeUnity', 'rehosta tutta la serie'],
    operations: [
      operation('search', 'Search a supported archive.', 'read', ['cercalo su AnimeUnity']),
      operation('availability', 'Verify a concrete episode.', 'read', [
        'è disponibile episodio 7?',
      ]),
      operation('rehost', 'Queue a verified episode rehost.', 'send', ['rehosta episodio 7'], {
        requiredReferents: ['canonical series', 'episode'],
        idempotency: 'provider_receipt',
        retry: 'never_blindly',
      }),
      operation('series_rehost', 'Queue a whole-series rehost.', 'send', ['rehosta la serie'], {
        requiredReferents: ['canonical series'],
        idempotency: 'provider_receipt',
        retry: 'checkpoint_only',
      }),
    ],
    adapterRisk: 'external_write',
    cortexVisible: true,
    terminal: true,
    requirements: ['approved chat', 'supported archive source', 'Telegram upload transport'],
    resourceClass: 'media',
    defaultTimeoutMs: 20_000,
    defaultMaxCalls: 1,
    outputKinds: ['video', 'text'],
    legacyProviderId: 'anime_archive',
  },
  web_search: {
    groundsClaims: true,
    description: 'Search current web results and inspect strong pages for verification.',
    examples: ['cerca tre fonti recenti', 'verifica online questa affermazione'],
    operations: [
      operation('search', 'Search and ground a current claim.', 'read', ['cerca online']),
    ],
    adapterRisk: 'read',
    cortexVisible: true,
    terminal: true,
    requirements: ['SearXNG'],
    resourceClass: 'network',
    defaultTimeoutMs: 30_000,
    defaultMaxCalls: 2,
    outputKinds: ['text', 'link'],
    legacyProviderId: 'web_search',
  },
  page_scan: {
    groundsClaims: true,
    description: 'Passively audit observable HTML, assets, quality and security headers.',
    examples: ['analizza example.org', 'guarda il sorgente pubblico e commenta il sito'],
    operations: [
      operation('audit', 'Audit one bounded public page without exploitation.', 'read', [
        'scansiona questa pagina',
      ]),
    ],
    adapterRisk: 'read',
    cortexVisible: true,
    terminal: true,
    requirements: ['public http(s) URL', 'safe egress'],
    resourceClass: 'network',
    defaultTimeoutMs: 30_000,
    defaultMaxCalls: 1,
    outputKinds: ['text', 'link'],
    legacyProviderId: 'page_scan',
  },
  news: {
    groundsClaims: true,
    description: 'Retrieve current curated news observations with source provenance.',
    examples: ['dammi le notizie di oggi', 'confronta queste news nel report'],
    operations: [operation('latest', 'Retrieve relevant current news.', 'read', ['news di oggi'])],
    adapterRisk: 'read',
    cortexVisible: true,
    terminal: false,
    requirements: ['configured news sources'],
    resourceClass: 'network',
    defaultTimeoutMs: 30_000,
    defaultMaxCalls: 2,
    outputKinds: ['text', 'link'],
    legacyProviderId: 'news',
  },
  image_lookup: {
    groundsClaims: true,
    description: 'Identify and web-ground an attached or replied image.',
    examples: ['chi è nella foto?', 'trova la fonte di questa immagine'],
    operations: [
      operation('identify', 'Identify visible content and find evidence.', 'read', ['identifica']),
    ],
    adapterRisk: 'read',
    cortexVisible: true,
    terminal: true,
    requirements: ['visual input', 'vision and web grounding'],
    resourceClass: 'network',
    defaultTimeoutMs: 45_000,
    defaultMaxCalls: 1,
    outputKinds: ['text', 'link'],
    legacyProviderId: 'image_lookup',
  },
  document_read: {
    description: 'Read and analyze an already extracted attached or replied document.',
    examples: ['riassumi questo PDF', 'confronta i due documenti'],
    operations: [
      operation('read', 'Analyze extracted document content.', 'compute', ['leggi il PDF']),
    ],
    adapterRisk: 'compute',
    cortexVisible: false,
    terminal: true,
    requirements: ['readable extracted document'],
    resourceClass: 'interactive',
    defaultTimeoutMs: 60_000,
    defaultMaxCalls: 1,
    outputKinds: ['text', 'document'],
    legacyProviderId: 'document_read',
  },
  document_create: {
    description:
      'Create an actual downloadable report, document or data export as Markdown, TXT, CSV, JSON, PDF or DOCX; combine verified provider results.',
    examples: ['preparami un PDF con fonti', 'esporta questi dati in CSV', 'scrivi un report Word'],
    operations: [
      operation(
        'create',
        'Create a verified document attachment.',
        'generate',
        ['crea un documento'],
        {
          requiredReferents: ['document brief or content'],
          idempotency: 'effect_key',
          retry: 'checkpoint_only',
        },
      ),
    ],
    adapterRisk: 'generate',
    cortexVisible: true,
    terminal: true,
    requirements: [
      'chat model; LibreOffice for PDF and DOCX; pdftotext (Poppler) for PDF text verification only',
    ],
    resourceClass: 'generation',
    defaultTimeoutMs: 180_000,
    defaultMaxCalls: 2,
    outputKinds: ['document'],
    legacyProviderId: 'document_create',
  },
  data_analysis: {
    description:
      'Compute verified statistics and grouped totals from bounded CSV or JSON data; produce a statistics CSV and a chart SVG without model-invented arithmetic.',
    examples: ['analizza questo CSV', 'somma le vendite per regione e crea un grafico'],
    operations: [
      operation('summarize', 'Compute exact decimal column statistics.', 'compute', [
        'analizza i dati',
      ]),
      operation(
        'group_by',
        'Compute grouped statistics for a selected numeric column.',
        'compute',
        ['somma per categoria'],
      ),
    ],
    adapterRisk: 'compute',
    cortexVisible: true,
    terminal: true,
    requirements: ['one complete CSV or JSON data source'],
    resourceClass: 'interactive',
    defaultTimeoutMs: 15_000,
    defaultMaxCalls: 2,
    outputKinds: ['text', 'document'],
    legacyProviderId: 'data_analysis',
  },
  workflow: {
    description:
      'Create, inspect, amend or cancel durable personal reminders and recurring scheduled messages within this chat.',
    examples: [
      'ricordamelo tra venti minuti',
      'avvisami ogni lunedì',
      'sposta il promemoria di un’ora',
      'annulla quel promemoria',
    ],
    operations: [
      operation(
        'create',
        'Persist a reminder or recurring message.',
        'write',
        ['ricordamelo domani'],
        {
          requiredReferents: ['time', 'reminder content'],
          idempotency: 'effect_key',
          retry: 'checkpoint_only',
        },
      ),
      operation(
        'list',
        'List reminders visible to the requesting user in this conversation.',
        'read',
        ['quali promemoria ho?'],
      ),
      operation('update', 'Amend a uniquely identified reminder.', 'write', ['spostalo a domani'], {
        requiredReferents: ['reminder identity'],
        idempotency: 'effect_key',
        retry: 'checkpoint_only',
      }),
      operation(
        'cancel',
        'Cancel a uniquely identified reminder.',
        'write',
        ['annulla il promemoria'],
        {
          requiredReferents: ['reminder identity'],
          idempotency: 'effect_key',
          retry: 'checkpoint_only',
        },
      ),
    ],
    adapterRisk: 'compute',
    cortexVisible: true,
    terminal: true,
    requirements: ['durable reminder service', 'host-authorized current conversation'],
    resourceClass: 'interactive',
    defaultTimeoutMs: 15_000,
    defaultMaxCalls: 3,
    outputKinds: ['text'],
    legacyProviderId: 'workflow',
  },
  media_prompt: {
    description: 'Prepare a coherent context-aware image or video brief.',
    examples: ['prepara il concept visivo'],
    operations: [
      operation('prepare', 'Prepare a media generation brief.', 'compute', ['prepara il prompt']),
    ],
    adapterRisk: 'compute',
    cortexVisible: false,
    terminal: false,
    requirements: ['chat model'],
    resourceClass: 'generation',
    defaultTimeoutMs: 60_000,
    defaultMaxCalls: 2,
    outputKinds: ['text'],
    legacyProviderId: 'media_prompt',
  },
  image_gen: {
    description: 'Generate and verify a real image artifact.',
    examples: ['generami un meme', 'fammi tre immagini originali'],
    operations: [
      operation('generate', 'Generate an image artifact.', 'generate', ['genera immagine'], {
        requiredReferents: ['visual brief'],
        idempotency: 'effect_key',
        retry: 'checkpoint_only',
      }),
    ],
    adapterRisk: 'generate',
    cortexVisible: true,
    terminal: true,
    requirements: ['image provider', 'media quota'],
    resourceClass: 'generation',
    defaultTimeoutMs: 180_000,
    defaultMaxCalls: 1,
    outputKinds: ['image'],
    legacyProviderId: 'image_generation',
  },
  video_gen: {
    description: 'Generate and prepare a verified short video artifact.',
    examples: ['crea un video breve'],
    operations: [
      operation('generate', 'Generate a video artifact.', 'generate', ['genera video'], {
        requiredReferents: ['visual brief'],
        idempotency: 'effect_key',
        retry: 'checkpoint_only',
      }),
    ],
    adapterRisk: 'generate',
    cortexVisible: true,
    terminal: true,
    requirements: ['video provider', 'media quota'],
    resourceClass: 'generation',
    defaultTimeoutMs: 900_000,
    defaultMaxCalls: 1,
    outputKinds: ['video'],
    legacyProviderId: 'video_generation',
  },
  music: {
    description: 'Find, acquire and prepare a song as a Telegram voice note.',
    examples: ['scaricami questa canzone'],
    operations: [
      operation(
        'acquire',
        'Acquire and transcode requested music.',
        'generate',
        ['scarica canzone'],
        {
          requiredReferents: ['track'],
          idempotency: 'effect_key',
          retry: 'checkpoint_only',
        },
      ),
    ],
    adapterRisk: 'generate',
    cortexVisible: true,
    terminal: true,
    requirements: ['music provider', 'ffmpeg'],
    resourceClass: 'media',
    defaultTimeoutMs: 900_000,
    defaultMaxCalls: 1,
    outputKinds: ['audio'],
    legacyProviderId: 'music',
  },
  link_media: {
    description: 'Resolve an existing media URL for bounded Telegram rehosting.',
    examples: ['scarica questo link', 'rehostalo'],
    operations: [
      operation('resolve', 'Resolve a media URL for transport.', 'read', ['rehosta il link']),
    ],
    adapterRisk: 'read',
    cortexVisible: true,
    terminal: true,
    requirements: ['supported URL', 'safe downloader'],
    resourceClass: 'media',
    defaultTimeoutMs: 60_000,
    defaultMaxCalls: 4,
    outputKinds: ['link'],
    legacyProviderId: 'link_media',
  },
  translate: {
    description: 'Translate supplied text or a dependency result precisely.',
    examples: ['traduci questo in inglese'],
    operations: [operation('translate', 'Translate text.', 'compute', ['traduci'])],
    adapterRisk: 'compute',
    cortexVisible: true,
    terminal: true,
    requirements: ['chat model'],
    resourceClass: 'interactive',
    defaultTimeoutMs: 60_000,
    defaultMaxCalls: 2,
    outputKinds: ['text'],
    legacyProviderId: 'translation',
  },
  tts: {
    description: 'Synthesize supplied or dependency text as a Telegram voice note.',
    examples: ['mandamelo vocale'],
    operations: [
      operation('synthesize', 'Synthesize speech.', 'generate', ['leggilo a voce'], {
        requiredReferents: ['source text'],
        idempotency: 'effect_key',
        retry: 'checkpoint_only',
      }),
    ],
    adapterRisk: 'generate',
    cortexVisible: true,
    terminal: true,
    requirements: ['TTS provider'],
    resourceClass: 'generation',
    defaultTimeoutMs: 90_000,
    defaultMaxCalls: 1,
    outputKinds: ['audio'],
    legacyProviderId: 'tts',
  },
  capability_forge: {
    groundsClaims: true,
    description: 'Research, propose and optionally install a safe declarative research workflow.',
    examples: ['impara a cercare questi dati'],
    operations: [
      ...['disable', 'enable', 'retire'].map((id) =>
        operation(id, `${id} an installed versioned recipe`, 'write', [], {
          requiredReferents: ['installed recipe', 'authorized actor'],
          idempotency: 'effect_key',
          retry: 'checkpoint_only',
        }),
      ),
      operation('execute', 'Execute an installed declarative recipe.', 'read', [
        'usa la capacità già installata',
      ]),
      operation('propose', 'Prepare a capability proposal.', 'draft', ['proponi una capability']),
      operation(
        'install',
        'Install a validated declarative recipe.',
        'write',
        ['impara questa capacità'],
        {
          requiredReferents: ['validated recipe', 'authorized actor'],
          idempotency: 'effect_key',
          retry: 'checkpoint_only',
        },
      ),
    ],
    adapterRisk: 'compute',
    cortexVisible: true,
    terminal: true,
    requirements: ['Capability Forge', 'web grounding', 'installation authority'],
    resourceClass: 'network',
    defaultTimeoutMs: 180_000,
    defaultMaxCalls: 1,
    outputKinds: ['text'],
    legacyProviderId: 'capability_forge',
  },
};

const manifests = {} as Record<BuiltinCapabilityId, RuntimeCapabilityManifest>;
for (const id of BUILTIN_CAPABILITY_IDS) {
  const seed = seeds[id];
  manifests[id] = Object.freeze({
    ...seed,
    id,
    version: 1 as const,
    operations: Object.freeze(
      seed.operations.map((item) =>
        Object.freeze({
          ...item,
          inputSchema:
            id === 'page_scan'
              ? pageAuditInputSchema
              : id === 'workflow'
                ? workflowInputSchema
                : id === 'anime_archive'
                  ? animeArchiveInputSchema
                  : operationInputSchema,
          outputSchema: operationOutputSchema,
        }),
      ),
    ),
  });
}

export const RUNTIME_CAPABILITY_MANIFESTS: Readonly<
  Record<BuiltinCapabilityId, RuntimeCapabilityManifest>
> = Object.freeze(manifests);

export function runtimeCapabilityManifest(id: BuiltinCapabilityId): RuntimeCapabilityManifest {
  return RUNTIME_CAPABILITY_MANIFESTS[id];
}

export function isTerminalCapability(id: string): boolean {
  return id in RUNTIME_CAPABILITY_MANIFESTS
    ? RUNTIME_CAPABILITY_MANIFESTS[id as BuiltinCapabilityId].terminal
    : false;
}

export function legacyProviderFor(id: BuiltinCapabilityId): string {
  return runtimeCapabilityManifest(id).legacyProviderId;
}

export function assertCapabilityHandlerCoverage(
  advertised: readonly string[],
  handlers: Readonly<Record<string, unknown>>,
): void {
  const missing = advertised.filter((id) => typeof handlers[id] !== 'function');
  if (missing.length > 0) {
    throw new Error(`Runtime capability handler missing: ${missing.join(', ')}`);
  }
}

interface CapabilityActionInput {
  query?: string;
  args: Record<string, unknown>;
  dependsOn?: readonly string[];
}

interface CapabilityOutputInput {
  summary: string;
  verified?: boolean;
  evidence?: Array<{ source: string }>;
  artifacts?: Array<{ kind: CapabilityArtifactKind; id: string }>;
}

export function validateCapabilityInvocation(
  id: BuiltinCapabilityId,
  action: CapabilityActionInput,
): string[] {
  const manifest = runtimeCapabilityManifest(id);
  const operationId = operationIdForInvocation(id, action.args);
  const selected = manifest.operations.find((item) => item.id === operationId);
  if (!selected) return [`unknown operation ${operationId ?? '(missing)'}`];
  if (
    id === 'page_scan' &&
    action.dependsOn?.length &&
    !action.query?.trim() &&
    typeof action.args['url'] !== 'string'
  ) {
    return [];
  }
  const parsed = selected.inputSchema.safeParse({
    ...(action.query ? { query: action.query } : {}),
    args: action.args,
  });
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`);
}

export function validateCapabilityOutput(
  id: BuiltinCapabilityId,
  action: CapabilityActionInput,
  output: CapabilityOutputInput,
): string[] {
  const manifest = runtimeCapabilityManifest(id);
  const operationId = operationIdForInvocation(id, action.args);
  const selected = manifest.operations.find((item) => item.id === operationId);
  if (!selected) return [`unknown operation ${operationId ?? '(missing)'}`];
  const parsed = selected.outputSchema.safeParse({
    summary: output.summary,
    verified: output.verified !== false,
    sources: output.evidence?.map((item) => item.source) ?? [],
    artifacts: output.artifacts?.map((item) => ({ kind: item.kind, id: item.id })) ?? [],
  });
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join('.') || 'output'}: ${issue.message}`);
}

export function operationIdForInvocation(
  id: BuiltinCapabilityId,
  args: Record<string, unknown>,
): string | null {
  const explicit = typeof args['operation'] === 'string' ? args['operation'] : null;
  if (explicit) return explicit;
  const intent = typeof args['intent'] === 'string' ? args['intent'] : null;
  if (id === 'anime_archive') return intent === 'series' ? 'series_rehost' : intent;
  if (id === 'workflow') return intent;
  if (id === 'companion_memory') return intent || 'recall';
  if (id === 'connected_service') return intent || 'list';
  if (id === 'code_work') return intent || 'status';
  if (id === 'data_analysis')
    return typeof args['operation'] === 'string' ? args['operation'] : 'summarize';
  if (id === 'anime_knowledge') {
    if (intent === 'follow' || intent === 'unfollow') return intent;
    return 'lookup';
  }
  if (id === 'capability_forge') {
    if (intent && ['disable', 'enable', 'retire'].includes(intent)) return intent;
    if (typeof args['command'] === 'string' || typeof args['recipeId'] === 'string')
      return 'execute';
    return 'propose';
  }
  return runtimeCapabilityManifest(id).operations[0]?.id ?? null;
}

export interface RuntimeCapabilitySnapshotItem {
  id: BuiltinCapabilityId;
  version: 1;
  description: string;
  readiness: CapabilityReadiness;
  reason: string | null;
  checkedAt: string;
  operations: ReadonlyArray<{ id: string; effect: CapabilityEffect }>;
}

export function capabilitySnapshot(
  readiness: Partial<Record<BuiltinCapabilityId, { state: CapabilityReadiness; reason?: string }>>,
  checkedAt = new Date(),
): RuntimeCapabilitySnapshotItem[] {
  return BUILTIN_CAPABILITY_IDS.map((id) => {
    const manifest = runtimeCapabilityManifest(id);
    const state = readiness[id] ?? {
      state: 'unavailable' as const,
      reason: 'not evaluated for this turn',
    };
    return {
      id,
      version: manifest.version,
      description: manifest.description,
      readiness: state.state,
      reason: state.reason ?? null,
      checkedAt: checkedAt.toISOString(),
      operations: manifest.operations.map((item) => ({ id: item.id, effect: item.effect })),
    };
  });
}

export function cortexCapabilitiesFromSnapshot(
  snapshot: readonly RuntimeCapabilitySnapshotItem[],
): CortexCapabilityId[] {
  const cortexIds = new Set<string>(CORTEX_CAPABILITY_IDS);
  return snapshot
    .filter(
      (item): item is RuntimeCapabilitySnapshotItem & { id: CortexCapabilityId } =>
        cortexIds.has(item.id) && (item.readiness === 'ready' || item.readiness === 'degraded'),
    )
    .map((item) => item.id);
}
