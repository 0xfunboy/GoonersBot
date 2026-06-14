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
  minConfidence: number;
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
}

export interface AutoEngageDecision {
  shouldReply: boolean;
  reason: string;
  score?: AutoEngageScore;
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

    // Direct address: reply almost always. Still respect a hard per-hour cap to avoid chain-spam,
    // but a mention is a strong signal so it bypasses the soft cooldowns.
    if (mentionedOrReplied) {
      if (!this.hourlyCap.isUnderLimit(chatKey)) {
        return { shouldReply: false, reason: 'hourly reply cap reached' };
      }
      return { shouldReply: true, reason: 'directly addressed' };
    }

    if (!autoengageEnabled) {
      return { shouldReply: false, reason: 'autoengage disabled' };
    }

    // Passive autoengage: enforce limits before spending an LLM call.
    if (!this.hourlyCap.isUnderLimit(chatKey)) {
      return { shouldReply: false, reason: 'hourly reply cap reached' };
    }
    if (!this.chatCooldown.isReady(chatKey)) {
      return { shouldReply: false, reason: 'chat cooldown active' };
    }
    if (!this.userCooldown.isReady(`${chatKey}:${inputs.person.userHandle}`)) {
      return { shouldReply: false, reason: 'user cooldown active' };
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
      });
      score = await this.llm.scoreAutoEngage({ prompt, system: buildAutoEngageSystem() });
    } catch (err) {
      log.warn({ err }, 'autoengage scoring failed — not engaging');
      return { shouldReply: false, reason: 'scoring failed' };
    }

    if (!score.shouldReply) {
      return { shouldReply: false, reason: `model declined: ${score.reason}`, score };
    }
    if (score.confidence < this.cfg.minConfidence) {
      return {
        shouldReply: false,
        reason: `confidence ${score.confidence.toFixed(2)} < ${this.cfg.minConfidence}`,
        score,
      };
    }
    if (score.risk === 'high') {
      return { shouldReply: false, reason: 'high risk', score };
    }
    return { shouldReply: true, reason: score.reason, score };
  }
}
