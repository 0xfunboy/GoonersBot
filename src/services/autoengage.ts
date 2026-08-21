import type { ChatContext, Person } from '../domain/types.js';
import type { LLMProvider, AutoEngageScore } from '../providers/llm/types.js';
import { buildAutoEngagePrompt, buildAutoEngageSystem } from '../prompts/index.js';
import type { StoredMessage } from '../storage/repositories/messages.js';
import { BOT_LABEL } from './conversation.js';
import { Cooldown, SlidingWindowCounter } from '../utils/rateLimit.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('autoengage');

export interface AutoEngageConfig {
  maxRepliesPerChatPerHour: number;
  chatCooldownSeconds: number;
  userCooldownSeconds: number;
  model?: string;
  maxTokens?: number;
  minConfidence: number;
  /** Confidence rebate applied when the turn is about a domain the bot holds real facts for. */
  knownTopicBonus?: number;
}

export type ConversationInvolvementKind = 'direct' | 'reply_chain' | 'hot_thread' | 'none';

export interface ConversationInvolvement {
  kind: ConversationInvolvementKind;
  /** Number of reply edges from the current message to a bot-authored ancestor, when known. */
  replyDepth: number;
  recentBotTurns: number;
  recentBotBranchMessages: number;
  reason: string;
}

export interface AutoEngageInputs {
  person: Person;
  context: ChatContext;
  currentMessage: string;
  modeName: string;
  modeDescription: string;
  history: StoredMessage[];
  userFacts: string[];
  groupFacts: Array<{ handle: string; fact: string }>;
  /** raise the bar after recent replies were criticized/landed badly */
  recentNegativeFeedback?: boolean;
  /**
   * True when ambient classification recognised the topic.
   *
   * This is the difference between the bot interrupting at random and interrupting because it
   * genuinely has something to add, so it lowers the bar - it never removes it.
   */
  knownTopic?: boolean;
  /** Current bot username, used only to render/recognize Telegram reply arrows when available. */
  botUsername?: string;
}

export interface AutoEngageDecision {
  shouldReply: boolean;
  reason: string;
  score?: AutoEngageScore;
  maxReplyLength: 'tiny' | 'short' | 'normal';
  shouldUseMemory: boolean;
}

/**
 * Decides whether the bot should intervene. Direct mentions/replies almost always pass.
 * Passive autoengage runs the LLM scorer and is gated by per-chat / per-user cooldowns,
 * a per-hour reply cap, and a minimum confidence threshold. Never chain-spams.
 */
export class AutoEngageScorer {
  private readonly chatCooldown: Cooldown;
  private readonly userCooldown: Cooldown;
  private readonly hourlyCap: SlidingWindowCounter;

  constructor(
    private readonly llm: LLMProvider,
    private readonly cfg: AutoEngageConfig,
  ) {
    this.chatCooldown = new Cooldown(cfg.chatCooldownSeconds * 1000);
    this.userCooldown = new Cooldown(cfg.userCooldownSeconds * 1000);
    this.hourlyCap = new SlidingWindowCounter(60 * 60 * 1000, cfg.maxRepliesPerChatPerHour);
  }

  /** Record that the bot actually replied (advances cooldowns + hourly counter). */
  noteReply(chatId: number, userHandle: string): void {
    const now = Date.now();
    this.chatCooldown.mark(`${chatId}`, now);
    this.userCooldown.mark(`${chatId}:${userHandle}`, now);
    this.hourlyCap.record(`${chatId}`, now);
  }

  /**
   * @param mentionedOrReplied true when the bot was directly addressed (mention or reply-to-bot).
   * @param autoengageEnabled chat-level /autoengage toggle.
   */
  async decide(
    inputs: AutoEngageInputs,
    mentionedOrReplied: boolean,
    autoengageEnabled: boolean,
  ): Promise<AutoEngageDecision> {
    const chatKey = `${inputs.context.chatId}`;
    const no = (reason: string, score?: AutoEngageScore): AutoEngageDecision => ({
      shouldReply: false,
      reason,
      maxReplyLength: 'tiny',
      shouldUseMemory: false,
      ...(score ? { score } : {}),
    });

    // Direct address: reply almost always. Still respect a hard per-hour cap to avoid chain-spam,
    // but a mention is a strong signal so it bypasses the soft cooldowns.
    if (mentionedOrReplied) {
      if (!this.hourlyCap.isUnderLimit(chatKey)) return no('hourly reply cap reached');
      return {
        shouldReply: true,
        reason: 'directly addressed',
        maxReplyLength: 'normal',
        shouldUseMemory: true,
      };
    }

    if (!autoengageEnabled) return no('autoengage disabled');

    const involvement = analyzeConversationInvolvement(inputs);

    // Passive autoengage: enforce limits before spending an LLM call. A reply-chain continuation is
    // not the same as barging into unrelated chatter, so it gets a much shorter pacing floor while
    // the hard hourly cap remains untouched.
    if (!this.hourlyCap.isUnderLimit(chatKey)) return no('hourly reply cap reached');
    if (!cooldownReady(this.chatCooldown, chatKey, this.cfg.chatCooldownSeconds, involvement, 12)) {
      return no('chat cooldown active');
    }
    if (
      !cooldownReady(
        this.userCooldown,
        `${chatKey}:${inputs.person.userHandle}`,
        this.cfg.userCooldownSeconds,
        involvement,
        8,
      )
    ) {
      return no('user cooldown active');
    }
    if (!worthScoring(inputs.currentMessage, involvement)) {
      return no('low-information passive message');
    }

    let score: AutoEngageScore;
    try {
      const prompt = buildAutoEngagePrompt({
        modeName: inputs.modeName,
        modeDescription: inputs.modeDescription,
        history: inputs.history,
        currentMessage: inputs.currentMessage,
        userHandle: inputs.person.userHandle,
        userFacts: inputs.userFacts,
        groupFacts: inputs.groupFacts,
        isMentionedOrReplied: false,
        recentBotReplies: inputs.history.filter((m) => m.isBot).length,
        conversationEnergy: inputs.history.length,
        botLabel: BOT_LABEL,
        botUsername: inputs.botUsername,
        replyToHandle: inputs.context.repliedToUserHandle,
        replyToText: inputs.context.repliedToText,
        involvement,
      });
      score = await this.llm.scoreAutoEngage({
        prompt,
        system: buildAutoEngageSystem(),
        ...(this.cfg.model ? { model: this.cfg.model } : {}),
        maxTokens: this.cfg.maxTokens ?? 160,
      });
    } catch (err) {
      log.warn({ err }, 'autoengage scoring failed - not engaging');
      return no('scoring failed');
    }

    // Knowing a topic barely changes the threshold; already being part of the exact reply branch
    // changes it materially. This is the difference between unsolicited punditry and continuing a
    // conversation humans are already having with/about the bot.
    const involvementBonus =
      involvement.kind === 'reply_chain' ? 0.18 : involvement.kind === 'hot_thread' ? 0.08 : 0;
    const minConfidence = Math.max(
      0.05,
      this.cfg.minConfidence +
        (inputs.recentNegativeFeedback ? 0.25 : 0) -
        (inputs.knownTopic ? Math.min(0.03, this.cfg.knownTopicBonus ?? 0) : 0) -
        involvementBonus +
        (score.risk === 'medium' ? 0.08 : 0),
    );
    const semiAddressed =
      involvement.kind === 'reply_chain' &&
      involvement.replyDepth > 0 &&
      involvement.replyDepth <= 2 &&
      !inputs.recentNegativeFeedback;
    if (score.risk === 'high') return no('high risk', score);
    if (!score.shouldReply && !semiAddressed) return no(`model declined: ${score.reason}`, score);
    if (score.confidence < minConfidence && !semiAddressed) {
      return no(`confidence ${score.confidence.toFixed(2)} < ${minConfidence.toFixed(2)}`, score);
    }
    if (!score.shouldReply && semiAddressed) {
      log.debug(
        {
          chatId: inputs.context.chatId,
          replyDepth: involvement.replyDepth,
          modelReason: score.reason,
        },
        'reply-chain continuation treated as semi-addressed despite passive scorer decline',
      );
    }
    return {
      shouldReply: true,
      reason:
        semiAddressed && !score.shouldReply
          ? `reply-chain continuation: ${score.reason}`
          : score.reason,
      score,
      // Passive participation should look like a quick human interjection, never a mini editorial.
      maxReplyLength: 'tiny',
      shouldUseMemory: false,
    };
  }
}

export function analyzeConversationInvolvement(
  inputs: Pick<AutoEngageInputs, 'context' | 'history' | 'botUsername'>,
): ConversationInvolvement {
  if (!inputs.context.isGroup || inputs.context.isBotMentioned || inputs.context.isReplyToBot) {
    return {
      kind: 'direct',
      replyDepth: inputs.context.isReplyToBot ? 1 : 0,
      recentBotTurns: inputs.history.filter((message) => message.isBot).length,
      recentBotBranchMessages: 0,
      reason: 'direct bot address',
    };
  }

  const byId = new Map<number, StoredMessage>();
  for (const message of inputs.history) {
    if (typeof message.messageId === 'number') byId.set(message.messageId, message);
  }
  const botUsername = normalizeHandle(inputs.botUsername ?? '');
  const pointsToBot = (message: StoredMessage): boolean => {
    if (message.isBot) return true;
    if (message.replyToHandle && botUsername) {
      return normalizeHandle(message.replyToHandle) === botUsername;
    }
    if (typeof message.replyToMessageId === 'number') {
      return byId.get(message.replyToMessageId)?.isBot === true;
    }
    return false;
  };
  const botAncestorDepth = (messageId: number | null | undefined, maxDepth = 3): number => {
    let currentId = messageId;
    for (let depth = 1; depth <= maxDepth; depth += 1) {
      if (typeof currentId !== 'number') return 0;
      const current = byId.get(currentId);
      if (!current) return 0;
      if (current.isBot) return depth;
      if (pointsToBot(current)) return depth + 1;
      currentId = current.replyToMessageId;
    }
    return 0;
  };

  const replyDepth = botAncestorDepth(inputs.context.repliedToMessageId, 3);
  if (replyDepth > 0) {
    return {
      kind: 'reply_chain',
      replyDepth,
      recentBotTurns: inputs.history.filter((message) => message.isBot).length,
      recentBotBranchMessages: 1,
      reason: `current reply descends from a bot message (${replyDepth} edges)`,
    };
  }

  const recent = inputs.history.slice(-8);
  const recentBotTurns = recent.filter((message) => message.isBot).length;
  const branchMessages = recent.filter(
    (message) =>
      !message.isBot && (pointsToBot(message) || botAncestorDepth(message.messageId, 2) > 0),
  ).length;
  const latestTs = recent.at(-1)?.message.timestamp?.getTime?.() ?? 0;
  const latestBotTs = [...recent]
    .reverse()
    .find((message) => message.isBot)
    ?.message.timestamp?.getTime?.();
  const botRecentlyActive =
    latestTs > 0 && typeof latestBotTs === 'number' && latestTs - latestBotTs <= 5 * 60_000;
  if (botRecentlyActive && recentBotTurns >= 2 && branchMessages >= 2) {
    return {
      kind: 'hot_thread',
      replyDepth: 0,
      recentBotTurns,
      recentBotBranchMessages: branchMessages,
      reason: 'bot is already an active participant in the recent reply branch',
    };
  }

  return {
    kind: 'none',
    replyDepth: 0,
    recentBotTurns,
    recentBotBranchMessages: branchMessages,
    reason: 'no structural evidence that the bot is part of this branch',
  };
}

function cooldownReady(
  cooldown: Cooldown,
  key: string,
  configuredSeconds: number,
  involvement: ConversationInvolvement,
  involvedMinSeconds: number,
): boolean {
  const remaining = cooldown.remainingMs(key);
  if (remaining === 0) return true;
  if (involvement.kind !== 'reply_chain' && involvement.kind !== 'hot_thread') return false;
  const intervalMs = Math.max(0, configuredSeconds * 1000);
  const elapsedMs = Math.max(0, intervalMs - remaining);
  return elapsedMs >= Math.min(intervalMs, involvedMinSeconds * 1000);
}

function normalizeHandle(value: string): string {
  const clean = value.trim().toLowerCase();
  return clean.startsWith('@') ? clean : clean ? `@${clean}` : '';
}

function worthScoring(message: string, involvement: ConversationInvolvement): boolean {
  const text = message.trim();
  if (text.length < 3) return false;
  if (/^[\p{P}\p{S}\s]+$/u.test(text)) return false;
  if (/^(?:ok|okay|s[iì]|no|boh|mah|lol|lmao|ahah+a?|grazie|thanks|thx)[.!?]*$/i.test(text)) {
    return false;
  }
  // Short fragments like "13 mesi" are normally backchannel chatter. But the exact same fragment
  // can be meaningful when it continues a reply branch in which the bot is already a participant.
  if (
    text.length <= 28 &&
    !/[?!]/u.test(text) &&
    involvement.kind !== 'reply_chain' &&
    involvement.kind !== 'hot_thread'
  ) {
    return false;
  }
  return true;
}
