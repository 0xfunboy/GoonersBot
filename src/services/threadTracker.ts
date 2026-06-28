import { randomUUID } from 'node:crypto';
import type {
  ConversationEntityDoc,
  ConversationEntityType,
  ConversationThreadDoc,
} from '../domain/entities.js';
import type { ChatContext, IncomingMessage, Person } from '../domain/types.js';
import type { StoredMessage } from '../storage/repositories/messages.js';
import type { Storage } from '../storage/index.js';
import type { Embedder } from '../rag/embedder.js';
import { cosineSimilarity } from '../rag/types.js';
import { containsSensitive, redactSecrets } from '../utils/secrets.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('thread-tracker');

const STOP = new Set([
  'alla',
  'allo',
  'anche',
  'ancora',
  'bene',
  'cosa',
  'come',
  'devo',
  'della',
  'delle',
  'dello',
  'forse',
  'mio',
  'mia',
  'miei',
  'mie',
  'nuova',
  'nuovo',
  'perche',
  'perché',
  'pero',
  'però',
  'posso',
  'quanto',
  'questa',
  'questo',
  'quella',
  'quello',
  'sono',
  'that',
  'this',
  'what',
  'which',
  'with',
  'your',
]);

const VEHICLE_RE =
  /\b(rav4|toyota|ferrari|lamborghini|tesla|bmw|mercedes|audi|auto|macchina|plug[- ]?in|hybrid|ibrid[ao]|batteria)\b/i;
const PRODUCT_RE = /\b(rtx\s*50\d0|rtx|gpu|iphone|android|bitcoin|btc|eth|console|pc)\b/i;
const FIRST_PERSON_OWNER_RE =
  /\b(la mia|il mio|i miei|le mie|mia|mio|miei|mie|my|mine|me la|me lo|mi compro|ho comprato|devo comprare|vorrei comprare)\b/i;
const FOLLOWUP_RE =
  /\b(quanto|ancora|quella|quello|questa|questo|la mia|il mio|batteria|prezzo|conviene|durare|me la prendo|che devo fare|that|this|it|still|battery|price|worth)\b/i;

export interface ThreadTrackerConfig {
  enabled: boolean;
  ttlDays: number;
  maxActive: number;
  embeddingDim: number;
}

export interface ConversationThreadState {
  currentThread?: ConversationThreadDoc;
  currentEntities: ConversationEntityDoc[];
  relatedThreads: ConversationThreadDoc[];
  promptBlock?: string;
  memoryHandles: string[];
}

export class ConversationThreadTracker {
  constructor(
    private readonly storage: Storage,
    private readonly embedder: Embedder,
    private readonly cfg: ThreadTrackerConfig,
  ) {}

  async track(input: {
    person: Person;
    context: ChatContext;
    message: IncomingMessage;
    history: StoredMessage[];
  }): Promise<ConversationThreadState> {
    if (!this.cfg.enabled) return emptyState(input.person.userHandle, input.context);
    const text = (input.message.messageText ?? '').trim();
    if (!text) return emptyState(input.person.userHandle, input.context);
    // Never track, store or embed messages that carry secrets / credentials / personal data.
    if (containsSensitive(text)) return emptyState(input.person.userHandle, input.context);

    const aliases = extractAliases(text);
    const active = await this.storage.conversationThreads.listActive(
      input.context.chatId,
      this.cfg.maxActive,
    );
    const replyThread = input.context.repliedToMessageId
      ? await this.storage.conversationThreads.findByMessageId(
          input.context.chatId,
          input.context.repliedToMessageId,
        )
      : null;
    const aliasEntities = await this.storage.conversationEntities.findByAlias(
      input.context.chatId,
      aliases,
    );

    const semanticText = redactSecrets(semanticThreadText(text, aliases));
    const queryVec =
      this.embedder.enabled && active.some((t) => t.embedding?.length === this.cfg.embeddingDim)
        ? ((await this.embedder.embed([semanticText]))[0] ?? [])
        : [];
    const scored = active
      .map((thread, idx) => ({
        thread,
        score: scoreThread({
          thread,
          index: idx,
          aliases,
          text,
          currentHandle: input.person.userHandle,
          replyThreadId: replyThread?.threadId,
          aliasEntities,
          queryVec,
          embeddingDim: this.cfg.embeddingDim,
        }),
      }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    const shouldAttach = Boolean(
      replyThread || (best && best.score >= 0.55) || (isFollowup(text) && best && best.score >= 0.42),
    );
    const existing = shouldAttach ? (replyThread ?? best?.thread) : null;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.cfg.ttlDays * 24 * 3600_000);
    const owner = resolveOwner(text, input.person.userHandle, existing);
    const entity = buildEntity({
      chatId: input.context.chatId,
      text,
      aliases,
      ownerHandle: owner,
      introducedByHandle: existing?.introducedByHandle ?? input.person.userHandle,
      threadIds: existing ? [existing.threadId] : [],
      messageId: input.context.messageId,
      now,
      expiresAt,
    });
    const thread = await this.buildThread({
      existing,
      entity,
      aliases,
      text,
      person: input.person,
      context: input.context,
      now,
      expiresAt,
      semanticText,
    });
    entity.threadIds = [...new Set([...entity.threadIds, thread.threadId])];

    await Promise.all([
      this.storage.conversationThreads.upsert(thread),
      this.storage.conversationEntities.upsert(entity),
    ]);

    const related = scored
      .filter((s) => s.thread.threadId !== thread.threadId && s.score >= 0.3)
      .slice(0, 2)
      .map((s) => s.thread);
    const block = renderThreadBlock({
      speaker: input.person.userHandle,
      replyTo: input.context.repliedToUserHandle ?? null,
      current: thread,
      entities: [entity],
      related,
    });
    const memoryHandles = [
      input.person.userHandle,
      input.context.repliedToUserHandle ?? '',
      thread.ownerHandle ?? '',
      thread.introducedByHandle,
      ...thread.participantHandles,
    ].filter(Boolean);

    log.debug(
      {
        chatId: input.context.chatId,
        threadId: thread.threadId,
        title: thread.title,
        owner: thread.ownerHandle,
        aliases,
        attached: Boolean(existing),
      },
      'conversation thread tracked',
    );
    return {
      currentThread: thread,
      currentEntities: [entity],
      relatedThreads: related,
      promptBlock: block,
      memoryHandles: [...new Set(memoryHandles)],
    };
  }

  async attachMessage(chatId: number, threadId: string | undefined, messageId: number | undefined) {
    if (!threadId || messageId === undefined) return;
    await this.storage.conversationThreads.attachMessage(chatId, threadId, messageId);
  }

  private async buildThread(input: {
    existing: ConversationThreadDoc | null | undefined;
    entity: ConversationEntityDoc;
    aliases: string[];
    text: string;
    person: Person;
    context: ChatContext;
    now: Date;
    expiresAt: Date;
    semanticText: string;
  }): Promise<ConversationThreadDoc> {
    const title = input.existing?.title ?? titleFromAliases(input.aliases, input.text);
    const entityAliases = [...new Set([...(input.existing?.entityAliases ?? []), ...input.aliases])].slice(
      0,
      24,
    );
    const participantHandles = [
      ...(input.existing?.participantHandles ?? []),
      input.person.userHandle,
      input.context.repliedToUserHandle ?? '',
    ].filter(Boolean);
    const sourceMessageIds = [
      ...(input.existing?.sourceMessageIds ?? []),
      ...(input.context.messageId !== undefined ? [input.context.messageId] : []),
    ];
    const summary = summarizeThread(title, input.entity, input.text);
    const embedding =
      this.embedder.enabled && input.semanticText
        ? ((await this.embedder.embed([`${title}\n${summary}\n${entityAliases.join(' ')}`]))[0] ??
          input.existing?.embedding)
        : input.existing?.embedding;
    return {
      chatId: input.context.chatId,
      threadId: input.existing?.threadId ?? randomUUID(),
      title,
      summary,
      ownerHandle: input.existing?.ownerHandle ?? input.entity.ownerHandle ?? null,
      introducedByHandle: input.existing?.introducedByHandle ?? input.person.userHandle,
      participantHandles: [...new Set(participantHandles)].slice(-12),
      entityIds: [...new Set([...(input.existing?.entityIds ?? []), input.entity.entityId])],
      entityAliases,
      sourceMessageIds: [...new Set(sourceMessageIds)].slice(-40),
      lastMessageId: input.context.messageId ?? input.existing?.lastMessageId ?? null,
      lastSpeakerHandle: input.person.userHandle,
      ...(embedding?.length === this.cfg.embeddingDim ? { embedding } : {}),
      confidence: Math.max(input.existing?.confidence ?? 0, input.entity.confidence),
      status: 'active',
      createdAt: input.existing?.createdAt ?? input.now,
      updatedAt: input.now,
      expiresAt: input.expiresAt,
    };
  }
}

function emptyState(speaker: string, context: ChatContext): ConversationThreadState {
  return {
    currentEntities: [],
    relatedThreads: [],
    memoryHandles: [...new Set([speaker, context.repliedToUserHandle ?? ''].filter(Boolean))],
  };
}

function scoreThread(input: {
  thread: ConversationThreadDoc;
  index: number;
  aliases: string[];
  text: string;
  currentHandle: string;
  replyThreadId?: string | undefined;
  aliasEntities: ConversationEntityDoc[];
  queryVec: number[];
  embeddingDim: number;
}): number {
  let score = Math.max(0, 0.18 - input.index * 0.02);
  if (input.replyThreadId && input.thread.threadId === input.replyThreadId) score += 2;
  const threadAliases = new Set(input.thread.entityAliases.map(normalizeTerm));
  const overlap = input.aliases.filter((a) => threadAliases.has(a)).length;
  score += Math.min(0.8, overlap * 0.22);
  if (input.aliasEntities.some((e) => e.threadIds.includes(input.thread.threadId))) score += 0.55;
  if (input.thread.ownerHandle === input.currentHandle && isFollowup(input.text)) score += 0.3;
  if (input.queryVec.length === input.embeddingDim && input.thread.embedding?.length === input.embeddingDim) {
    const cos = cosineSimilarity(input.queryVec, input.thread.embedding);
    if (cos > 0.35) score += cos * 0.45;
  }
  return score;
}

function buildEntity(input: {
  chatId: number;
  text: string;
  aliases: string[];
  ownerHandle: string | null;
  introducedByHandle: string;
  threadIds: string[];
  messageId?: number | undefined;
  now: Date;
  expiresAt: Date;
}): ConversationEntityDoc {
  const canonicalName = titleFromAliases(input.aliases, input.text);
  const type = classifyEntity(input.text, input.aliases);
  return {
    chatId: input.chatId,
    entityId: stableEntityId(input.chatId, canonicalName, input.ownerHandle),
    type,
    canonicalName,
    aliases: input.aliases.slice(0, 18),
    ownerHandle: input.ownerHandle,
    introducedByHandle: input.introducedByHandle,
    attributes: attributesFromText(input.text).slice(0, 8),
    sourceMessageIds: input.messageId !== undefined ? [input.messageId] : [],
    threadIds: input.threadIds,
    confidence: input.aliases.length ? 0.75 : 0.45,
    createdAt: input.now,
    updatedAt: input.now,
    expiresAt: input.expiresAt,
  };
}

function renderThreadBlock(input: {
  speaker: string;
  replyTo: string | null;
  current: ConversationThreadDoc;
  entities: ConversationEntityDoc[];
  related: ConversationThreadDoc[];
}): string {
  const owner = input.current.ownerHandle ?? 'unknown';
  const relation =
    owner !== 'unknown' && owner !== input.speaker
      ? `${input.speaker} is talking about ${owner}'s thread/entity. Reply to ${input.speaker}, but do not make ${owner}'s facts belong to ${input.speaker}.`
      : `${input.speaker} owns or introduced the current thread unless the message explicitly says otherwise.`;
  const entityLines = input.entities
    .slice(0, 3)
    .map(
      (e) =>
        `- ${e.canonicalName} (${e.type}) owner=${e.ownerHandle ?? 'unknown'} aliases=${e.aliases.slice(0, 6).join(', ')}`,
    );
  const related = input.related.length
    ? `RELATED ACTIVE THREADS: ${input.related.map((t) => `${t.title} owner=${t.ownerHandle ?? 'unknown'}`).join(' | ')}`
    : '';
  return [
    'CONVERSATION THREAD STATE (working memory, use for attribution; do not quote it):',
    `Current speaker: ${input.speaker}${input.replyTo ? ` replying to ${input.replyTo}` : ''}.`,
    `Current thread: ${input.current.title}. Owner/subject: ${owner}. Introduced by: ${input.current.introducedByHandle}.`,
    `Thread summary: ${input.current.summary}`,
    entityLines.length ? `Entities:\n${entityLines.join('\n')}` : '',
    relation,
    'Roast rule: roast the current speaker for their claim/opinion; roast the owner only if the owner actually said or owns the thing being mocked.',
    related,
  ]
    .filter(Boolean)
    .join('\n');
}

function resolveOwner(
  text: string,
  currentHandle: string,
  existing: ConversationThreadDoc | null | undefined,
): string | null {
  if (FIRST_PERSON_OWNER_RE.test(text)) return currentHandle;
  return existing?.ownerHandle ?? currentHandle;
}

function isFollowup(text: string): boolean {
  const clean = text.trim();
  return clean.length <= 180 && FOLLOWUP_RE.test(clean);
}

function semanticThreadText(text: string, aliases: string[]): string {
  return [text, aliases.join(' ')].filter(Boolean).join('\n').slice(0, 600);
}

function extractAliases(text: string): string[] {
  const clean = normalizeText(text.replace(/@\w+/g, ' '));
  const aliases = new Set<string>();
  for (const m of clean.matchAll(/\b[a-z0-9][a-z0-9+.-]{2,}\b/gi)) {
    const term = normalizeTerm(m[0]);
    if (term.length >= 3 && !STOP.has(term)) aliases.add(term);
  }
  for (const m of clean.matchAll(/\b(rtx\s*50\d0|rav4|plug\s*in|plug-in|toyota|ferrari|lamborghini|bitcoin|btc)\b/gi)) {
    aliases.add(normalizeTerm(m[0]));
  }
  return [...aliases].slice(0, 18);
}

function attributesFromText(text: string): string[] {
  const attrs: string[] = [];
  if (/\b202\d\b/.test(text)) attrs.push(text.match(/\b202\d\b/)?.[0] ?? '');
  if (/\b\d+\s*(k|mila|€|eur|euro)\b/i.test(text)) attrs.push(text.match(/\b\d+\s*(k|mila|€|eur|euro)\b/i)?.[0] ?? '');
  if (/batteria/i.test(text)) attrs.push('battery mentioned');
  if (/permuta|concessionari|listino|prezzo/i.test(text)) attrs.push('price/trade-in context');
  return attrs.filter(Boolean);
}

function classifyEntity(text: string, aliases: string[]): ConversationEntityType {
  const hay = `${text} ${aliases.join(' ')}`;
  if (VEHICLE_RE.test(hay)) return 'vehicle';
  if (PRODUCT_RE.test(hay)) return 'product';
  return aliases.length ? 'topic' : 'object';
}

function summarizeThread(title: string, entity: ConversationEntityDoc, text: string): string {
  const attrs = entity.attributes.length ? ` Attributes: ${entity.attributes.join(', ')}.` : '';
  return `${title}; owner=${entity.ownerHandle ?? 'unknown'}; latest: ${text.replace(/\s+/g, ' ').trim().slice(0, 220)}.${attrs}`;
}

function titleFromAliases(aliases: string[], text: string): string {
  const preferred = aliases.filter((a) => /rav4|toyota|ferrari|lamborghini|rtx|bitcoin|btc|plug/.test(a));
  const picked = (preferred.length ? preferred : aliases).slice(0, 5);
  if (picked.length) return picked.map((p) => (p === 'rav4' ? 'RAV4' : p)).join(' ');
  return text.replace(/\s+/g, ' ').trim().slice(0, 60) || 'chat thread';
}

function stableEntityId(chatId: number, canonicalName: string, ownerHandle: string | null): string {
  return `${chatId}:${normalizeTerm(ownerHandle ?? 'group')}:${normalizeTerm(canonicalName)}`.slice(0, 160);
}

function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function normalizeTerm(text: string): string {
  return normalizeText(text).replace(/[^a-z0-9+.-]+/g, ' ').trim().replace(/\s+/g, ' ');
}
