import type { Storage } from '../storage/index.js';
import type { ConversationEntityDoc } from '../domain/entities.js';
import { childLogger } from '../utils/logger.js';
import type { AmbientFact } from './types.js';

const log = childLogger('ambient-affinity');

/** How long a recalled subject stays resolvable as a conversational referent. */
const ENTITY_TTL_HOURS = 12;

export interface AmbientObservationInput {
  chatId: number;
  userHandle: string;
  facts: readonly AmbientFact[];
  /** Thread the subject came up in, so a later "quando esce il prossimo?" resolves. */
  threadId?: string | undefined;
  messageId?: number | undefined;
}

/**
 * Turn recalled facts into two durable traces: what this chat is into, and what "it" refers to.
 *
 * Both are side effects of a conversation that already happened, so this never runs a model and
 * never blocks a reply - the caller fires it and moves on.
 */
export async function observeAmbientFacts(
  storage: Storage,
  input: AmbientObservationInput,
): Promise<void> {
  if (input.facts.length === 0) return;
  const now = new Date();

  for (const fact of input.facts) {
    const entityId = fact.entityId;
    if (!entityId) continue;
    try {
      await storage.topicAffinity.record(
        input.chatId,
        fact.domain,
        entityId,
        fact.subject,
        input.userHandle,
        now,
      );
      await trackEntity(storage, input, fact, entityId, now);
    } catch (error) {
      // Taste is a nice-to-have; never let it cost a reply.
      log.debug({ error, entityId }, 'ambient observation failed');
    }
  }
}

/**
 * Register the subject as a conversation entity.
 *
 * This is what makes a pronoun work: the group discusses Frieren, and twenty messages later
 * "quando esce il prossimo?" resolves through the existing thread-entity machinery instead of
 * being answered about nothing.
 */
async function trackEntity(
  storage: Storage,
  input: AmbientObservationInput,
  fact: AmbientFact,
  entityId: string,
  now: Date,
): Promise<void> {
  const doc: ConversationEntityDoc = {
    chatId: input.chatId,
    entityId,
    type: 'topic',
    canonicalName: fact.subject,
    aliases: [fact.subject.toLowerCase()],
    introducedByHandle: input.userHandle,
    // The domain is kept as an attribute rather than a new entity type: the existing taxonomy
    // already models "a thing being discussed", and forking it would split referent resolution.
    attributes: [`domain:${fact.domain}`, ...(fact.url ? [`url:${fact.url}`] : [])],
    sourceMessageIds: input.messageId === undefined ? [] : [input.messageId],
    threadIds: input.threadId ? [input.threadId] : [],
    confidence: fact.confidence,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + ENTITY_TTL_HOURS * 3_600_000),
  };
  await storage.conversationEntities.upsert(doc);
}
