import type { AppConfig } from '../config/index.js';
import type { LoreEngine, MineAndStoreResult } from '../memory/loreEngine.js';
import type { SocialLearningPipeline, SocialLearningResult } from '../social/index.js';
import type { Storage } from '../storage/index.js';
import type { MiningCursor } from '../storage/repositories/chats.js';
import type { StoredMessage } from '../storage/repositories/messages.js';
import { childLogger } from '../utils/logger.js';
import { DEFAULT_MINING_WINDOW_BYTES, miningMessagePromptBytes } from '../utils/miningPrompt.js';

const log = childLogger('job-mining');

interface MiningWindow {
  messages: StoredMessage[];
  eligibleSourceMessageIds: number[];
  cursor: MiningCursor;
  newHumanMessages: number;
}

interface DrainResult {
  processedMessages: number;
  windows: number;
  complete: boolean;
}

interface LoreDrainResult extends DrainResult, MineAndStoreResult {}

interface SocialDrainResult extends DrainResult {
  proposed: number;
  accepted: number;
  rejected: number;
  degraded: boolean;
}

let miningTail: Promise<void> = Promise.resolve();

/**
 * One global low-priority lane for bootstrap and scheduled mining. A 31B extraction can outlive a
 * scheduler tick; serialising it prevents duplicate calls, cursor races and competition with chat.
 */
export async function withContinuousMiningLock<T>(task: () => Promise<T>): Promise<T> {
  const previous = miningTail;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  miningTail = previous.then(
    () => gate,
    () => gate,
  );
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release?.();
  }
}

function timestampOf(message: StoredMessage): number {
  return new Date(message.message.timestamp).getTime();
}

function isAfterCursor(message: StoredMessage, cursor: MiningCursor): boolean {
  if (message.isBot) return false;
  if (message.messageId != null && cursor.messageId > 0) {
    return message.messageId > cursor.messageId;
  }
  return timestampOf(message) > cursor.timestamp;
}

function advanceCursor(cursor: MiningCursor, messages: StoredMessage[]): MiningCursor {
  let timestamp = cursor.timestamp;
  let messageId = cursor.messageId;
  for (const message of messages) {
    timestamp = Math.max(timestamp, timestampOf(message));
    if (message.messageId != null) messageId = Math.max(messageId, message.messageId);
  }
  return { timestamp, messageId };
}

/**
 * Split every unseen human message into bounded calls. Older messages remain visible as contextual
 * look-behind, but only ids in `eligibleSourceMessageIds` may become durable provenance.
 */
export function buildMiningWindows(
  messages: StoredMessage[],
  cursor: MiningCursor,
  batchSize: number,
  contextSize: number,
  maxWindowBytes = DEFAULT_MINING_WINDOW_BYTES,
): MiningWindow[] {
  const eligible = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => isAfterCursor(message, cursor));
  const safeBatchSize = Math.max(1, batchSize);
  const safeContextSize = Math.max(safeBatchSize, contextSize);
  const safeMaxWindowBytes = Math.max(1_024, maxWindowBytes);
  const messageBytes = messages.map(miningMessagePromptBytes);
  const prefixBytes = [0];
  for (const bytes of messageBytes) {
    prefixBytes.push((prefixBytes.at(-1) ?? 0) + bytes);
  }
  const rangeBytes = (start: number, end: number): number =>
    (prefixBytes[end + 1] ?? 0) - (prefixBytes[start] ?? 0);
  const windows: MiningWindow[] = [];
  let runningCursor = cursor;
  const batches: Array<Array<{ message: StoredMessage; index: number }>> = [];
  let currentBatch: Array<{ message: StoredMessage; index: number }> = [];
  let firstIndex = -1;
  for (const entry of eligible) {
    const { index } = entry;
    const wouldOverflowContext =
      currentBatch.length > 0 && index - firstIndex + 1 > safeContextSize;
    const wouldOverflowBytes =
      currentBatch.length > 0 && rangeBytes(firstIndex, index) > safeMaxWindowBytes;
    if (currentBatch.length >= safeBatchSize || wouldOverflowContext || wouldOverflowBytes) {
      batches.push(currentBatch);
      currentBatch = [];
      firstIndex = -1;
    }
    if (firstIndex < 0) firstIndex = index;
    currentBatch.push(entry);
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  for (const batch of batches) {
    const firstIndex = batch[0]?.index ?? -1;
    const lastIndex = batch.at(-1)?.index ?? -1;
    if (firstIndex < 0 || lastIndex < 0) continue;
    let start = firstIndex;
    // Fill only the remaining byte/count budget with look-behind. New evidence is never discarded;
    // if one bounded message itself exceeds the byte target it travels alone and the provider's
    // final token preflight remains the safety barrier.
    while (
      start > 0 &&
      lastIndex - start + 1 < safeContextSize &&
      rangeBytes(start - 1, lastIndex) <= safeMaxWindowBytes
    ) {
      start -= 1;
    }
    const windowMessages = messages.slice(start, lastIndex + 1);
    const batchMessages = batch.map(({ message }) => message);
    runningCursor = advanceCursor(runningCursor, batchMessages);
    windows.push({
      messages: windowMessages,
      eligibleSourceMessageIds: batchMessages
        .map((message) => message.messageId)
        .filter((id): id is number => id != null),
      cursor: runningCursor,
      newHumanMessages: batchMessages.length,
    });
  }
  return windows;
}

async function drainLore(params: {
  storage: Storage;
  lore: LoreEngine;
  chatId: number;
  language: string;
  nsfwEnabled: boolean;
  windows: MiningWindow[];
  minConfidence: number;
}): Promise<LoreDrainResult> {
  const aggregate: LoreDrainResult = {
    processedMessages: 0,
    windows: 0,
    complete: true,
    stored: 0,
    reinforced: 0,
    updated: 0,
    expired: 0,
    candidates: 0,
  };
  for (const window of params.windows) {
    try {
      const result = await params.lore.mineAndStore({
        chatId: params.chatId,
        messages: window.messages,
        eligibleSourceMessageIds: window.eligibleSourceMessageIds,
        language: params.language,
        nsfwEnabled: params.nsfwEnabled,
        minConfidence: params.minConfidence,
        source: 'auto',
        createdByHandle: null,
      });
      aggregate.processedMessages += window.newHumanMessages;
      aggregate.windows += 1;
      aggregate.stored += result.stored;
      aggregate.reinforced += result.reinforced;
      aggregate.updated += result.updated;
      aggregate.expired += result.expired;
      aggregate.candidates += result.candidates;
      await params.storage.chats.setLoreMiningCursor(params.chatId, window.cursor);
    } catch (err) {
      aggregate.complete = false;
      log.warn({ err, chatId: params.chatId }, 'lore mining window failed; cursor retained');
      break;
    }
  }
  return aggregate;
}

async function drainSocial(params: {
  storage: Storage;
  socialLearning: SocialLearningPipeline;
  chatId: number;
  language: string;
  windows: MiningWindow[];
}): Promise<SocialDrainResult> {
  const aggregate: SocialDrainResult = {
    processedMessages: 0,
    windows: 0,
    complete: true,
    proposed: 0,
    accepted: 0,
    rejected: 0,
    degraded: false,
  };
  for (const window of params.windows) {
    try {
      const result: SocialLearningResult = await params.socialLearning.learn({
        chatId: params.chatId,
        messages: window.messages,
        eligibleSourceMessageIds: window.eligibleSourceMessageIds,
        language: params.language,
      });
      aggregate.proposed += result.proposed;
      aggregate.accepted += result.accepted;
      aggregate.rejected += result.rejected;
      if (result.degraded) {
        aggregate.degraded = true;
        aggregate.complete = false;
        log.warn(
          { chatId: params.chatId },
          'social mining window degraded; cursor retained for structured retry',
        );
        break;
      }
      aggregate.processedMessages += window.newHumanMessages;
      aggregate.windows += 1;
      await params.storage.chats.setSocialMiningCursor(params.chatId, window.cursor);
    } catch (err) {
      aggregate.complete = false;
      log.warn({ err, chatId: params.chatId }, 'social mining window failed; cursor retained');
      break;
    }
  }
  return aggregate;
}

/**
 * Drain all retained unseen messages for every started chat. There is no plan, quota, relevance or
 * `/autofact` gate: every new human message reaches Gemma in bounded batches. Epistemic/privacy
 * validation still decides what is allowed to become durable memory.
 */
export async function runMemoryMiningJob(
  storage: Storage,
  lore: LoreEngine,
  config: AppConfig,
  socialLearning?: SocialLearningPipeline,
): Promise<void> {
  if (!config.env.MEMORY_MINING_ENABLED) return;
  await withContinuousMiningLock(async () => {
    const env = config.env;
    const chats = await storage.chats.listForMining();
    for (const chat of chats) {
      try {
        const messages = await storage.messages.getRecent(
          chat.chatId,
          env.MAX_STORED_MESSAGES_PER_CHAT,
        );
        if (!messages.some((message) => !message.isBot)) continue;
        const [loreCursor, socialCursor] = await Promise.all([
          storage.chats.getLoreMiningCursor(chat.chatId),
          storage.chats.getSocialMiningCursor(chat.chatId),
        ]);
        const loreWindows = buildMiningWindows(
          messages,
          loreCursor,
          env.MEMORY_MINING_BATCH_MESSAGES,
          env.MEMORY_MINING_CONTEXT_MESSAGES,
          env.MEMORY_MINING_MAX_WINDOW_BYTES,
        );
        const socialWindows = socialLearning
          ? buildMiningWindows(
              messages,
              socialCursor,
              env.MEMORY_MINING_BATCH_MESSAGES,
              env.MEMORY_MINING_CONTEXT_MESSAGES,
              env.MEMORY_MINING_MAX_WINDOW_BYTES,
            )
          : [];
        if (loreWindows.length === 0 && socialWindows.length === 0) continue;

        // A single dedicated route intentionally processes one structured call at a time.
        const loreResult = await drainLore({
          storage,
          lore,
          chatId: chat.chatId,
          language: chat.language,
          nsfwEnabled: chat.nsfwMode !== 'off',
          windows: loreWindows,
          minConfidence: env.MEMORY_AUTO_MIN_CONFIDENCE,
        });
        // Do not immediately double-tap a provider that just failed, nor continue through every
        // chat. Cursors retain the exact window and the next watchdog tick retries it.
        const socialResult =
          loreResult.complete && socialLearning
            ? await drainSocial({
                storage,
                socialLearning,
                chatId: chat.chatId,
                language: chat.language,
                windows: socialWindows,
              })
            : null;
        await storage.jobs.record('continuous_memory_mining', 'done', {
          chatId: chat.chatId,
          model: config.miningLlm.model,
          lore: loreResult,
          social: socialResult,
        });
        log.info(
          { chatId: chat.chatId, model: config.miningLlm.model, loreResult, socialResult },
          'continuous mining backlog drained',
        );
        if (!loreResult.complete || socialResult?.complete === false) break;
      } catch (err) {
        log.warn({ err, chatId: chat.chatId }, 'mining failed for chat');
        break;
      }
    }
  });
}
