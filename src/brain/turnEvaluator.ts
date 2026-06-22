import type { StoredMessage } from '../storage/repositories/messages.js';
import type { BotReplyRecord, ProviderRequest, SceneAnalysis, TurnEvaluation } from './types.js';

export interface TurnEvaluatorCapabilities {
  webSearch: boolean;
  imageLookup: boolean;
  news: boolean;
  knowledge: boolean;
}

export interface TurnEvaluatorInput {
  scene: SceneAnalysis;
  history: StoredMessage[];
  currentMessage: string;
  botIsAddressed: boolean;
  recentBotReplies: BotReplyRecord[];
  recentNegativeFeedback: boolean;
  capabilities: TurnEvaluatorCapabilities;
  groundingHints: {
    wantsWebSearch: boolean;
    wantsImageLookup: boolean;
  };
}

const TECH_RE =
  /\b(api|bug|codice|code|typescript|javascript|node|mongo|mongodb|docker|linux|server|deploy|errore|stack|git|repo|modello|llm|prompt|token|framework|database|query|config|env|build|test|typecheck)\b/i;

const FACTUAL_QUESTION_RE =
  /\b(chi|cosa|cos'è|cosa è|quando|dove|quanto|perché|perche|come funziona|è vero|e vero|is it true|who|what|when|where|why|how much|how many|latest|current|prezzo|risultat[oi]|classifica|versione|release|uscit[ao])\b/i;

const CLAIM_MARKER_RE =
  /\b(è|e'|sono|ha|hanno|non è|non e'|non sono|sempre|mai|tutti|nessuno|il primo|la prima|migliore|peggiore|only|never|always|is|are|was|were|has|have|released|won|lost|costs?)\b/i;

const WRONGNESS_RE =
  /\b(non è vero|fake|bufala|cazzata|stronzata|sbagli|sbagliato|impossibile|ma che dici|bullshit|wrong|false|cap|no way)\b/i;

const NEWS_RE =
  /\b(news|notizi[ae]|oggi|ieri|ultim[oaie]|appena|breaking|recent[ei]|stamattina|stasera|today|yesterday|latest|just announced|just released)\b/i;

const SUMMARY_RE = /\b(riassumi|recap|sunto|summary|che mi sono perso|cosa mi sono perso)\b/i;

const SUPPORT_RE =
  /\b(sono a pezzi|sto male|mi sento|ansia|panico|triste|incasinato|problema serio|ho bisogno|aiuto)\b/i;

const BANTER_RE =
  /\b(stronzo|coglione|vaffanculo|suca|cesso|scemo|rosica|blast|roast|prendi per il culo|lol|lmao|ahah|ahaha)\b/i;

const LOW_VALUE_RE = /^(ok|lol|ahaha+|ahah|si|sì|no|boh|mah|k)\W*$/i;

export class TurnEvaluator {
  evaluate(input: TurnEvaluatorInput): TurnEvaluation {
    const msg = input.currentMessage ?? '';
    const lower = msg.toLowerCase();
    const isQuestion = msg.includes('?') || FACTUAL_QUESTION_RE.test(msg);
    const isTech = TECH_RE.test(msg) || TECH_RE.test(input.scene.currentTopic);
    const isSupport = SUPPORT_RE.test(msg);
    const isSummary = SUMMARY_RE.test(msg);
    const isBanter = BANTER_RE.test(msg) || input.scene.userIntent === 'continue_banter';
    const isClaim = this.looksLikeClaim(msg);
    const recentCriticism =
      input.scene.botIsBeingCriticized ||
      input.recentNegativeFeedback ||
      this.recentlyCriticized(input);
    const requests: ProviderRequest[] = [];

    if (input.capabilities.knowledge) requests.push('knowledge_rag');
    if (!recentCriticism) requests.push('group_rag');

    if (input.scene.botIsBeingCriticized) {
      return this.turn({
        shouldAct: true,
        action: 'banter_only',
        providerRequests: [],
        valueTarget: 'social_glue',
        roastBudget: 'light',
        socialRole: 'friend',
        confidence: 0.9,
        reason: 'bot is being criticized; answer with self-awareness, not stale callbacks',
      });
    }

    if (!input.botIsAddressed && LOW_VALUE_RE.test(lower)) {
      return this.turn({
        shouldAct: false,
        action: 'stay_quiet',
        providerRequests: [],
        valueTarget: 'social_glue',
        roastBudget: 'none',
        socialRole: 'quiet_listener',
        confidence: 0.86,
        reason: 'passive low-value chatter',
      });
    }

    if (isSummary || input.scene.userIntent === 'request_summary') {
      return this.turn({
        shouldAct: true,
        action: 'summarize_thread',
        providerRequests: uniq(requests),
        valueTarget: 'context',
        roastBudget: recentCriticism ? 'none' : 'light',
        socialRole: 'friend',
        confidence: 0.86,
        reason: 'summary/recap request',
      });
    }

    if (input.groundingHints.wantsImageLookup && input.capabilities.imageLookup) {
      requests.push('image_lookup', 'web_search');
      return this.turn({
        shouldAct: true,
        action: 'ground_search',
        providerRequests: uniq(requests),
        valueTarget: 'truth',
        roastBudget: 'light',
        socialRole: 'truth_checker',
        confidence: 0.9,
        reason: 'image/product identity question needs lookup',
      });
    }

    if (input.groundingHints.wantsWebSearch && input.capabilities.webSearch) {
      requests.push('web_search');
      if (NEWS_RE.test(msg) && input.capabilities.news) requests.push('news');
      return this.turn({
        shouldAct: true,
        action: NEWS_RE.test(msg) ? 'bring_news_context' : 'ground_search',
        providerRequests: uniq(requests),
        valueTarget: 'truth',
        roastBudget: 'light',
        socialRole: isTech ? 'technical_peer' : 'truth_checker',
        confidence: 0.9,
        reason: 'fresh/current factual context required',
      });
    }

    if (isClaim && (WRONGNESS_RE.test(msg) || this.threadChallengesClaim(input))) {
      if (input.capabilities.webSearch) requests.push('web_search');
      return this.turn({
        shouldAct: true,
        action: 'challenge_claim',
        providerRequests: uniq(requests),
        valueTarget: 'truth',
        roastBudget: recentCriticism ? 'none' : 'light',
        socialRole: 'truth_checker',
        confidence: input.capabilities.webSearch ? 0.82 : 0.68,
        reason: 'checkable claim is being challenged',
      });
    }

    if (
      isQuestion ||
      input.scene.userIntent === 'ask_bot' ||
      input.scene.userIntent === 'dangerous_request'
    ) {
      return this.turn({
        shouldAct: true,
        action: 'answer',
        providerRequests: uniq(requests),
        valueTarget: isSupport ? 'support' : isTech ? 'technical_help' : 'truth',
        roastBudget: isSupport || recentCriticism ? 'none' : 'light',
        socialRole: isTech ? 'technical_peer' : 'friend',
        confidence: 0.8,
        reason: isTech ? 'direct technical/factual question' : 'direct question or request',
      });
    }

    if (!input.botIsAddressed && NEWS_RE.test(msg) && input.capabilities.news) {
      requests.push('news');
      return this.turn({
        shouldAct: true,
        action: 'bring_news_context',
        providerRequests: uniq(requests),
        valueTarget: 'context',
        roastBudget: 'light',
        socialRole: 'friend',
        confidence: 0.64,
        reason: 'passive recent-world topic where a short context drop can add value',
      });
    }

    if (isClaim && input.botIsAddressed) {
      if (input.capabilities.webSearch && NEWS_RE.test(msg)) requests.push('web_search');
      return this.turn({
        shouldAct: true,
        action: requests.includes('web_search') ? 'ground_search' : 'answer',
        providerRequests: uniq(requests),
        valueTarget: 'truth',
        roastBudget: 'light',
        socialRole: 'truth_checker',
        confidence: 0.68,
        reason: 'addressed checkable claim',
      });
    }

    if (isBanter || input.scene.userIntent === 'insult_bot') {
      return this.turn({
        shouldAct: input.botIsAddressed,
        action: 'banter_only',
        providerRequests: input.botIsAddressed ? uniq(requests) : [],
        valueTarget: 'joke',
        roastBudget: recentCriticism ? 'light' : 'heavy',
        socialRole: 'banter',
        confidence: input.botIsAddressed ? 0.74 : 0.42,
        reason: input.botIsAddressed ? 'direct banter' : 'passive banter without enough value',
      });
    }

    return this.turn({
      shouldAct: input.botIsAddressed,
      action: input.botIsAddressed ? 'use_group_lore' : 'stay_quiet',
      providerRequests: input.botIsAddressed ? uniq(requests) : [],
      valueTarget: input.botIsAddressed ? 'social_glue' : 'context',
      roastBudget: recentCriticism ? 'none' : 'medium',
      socialRole: input.botIsAddressed ? 'friend' : 'quiet_listener',
      confidence: input.botIsAddressed ? 0.62 : 0.52,
      reason: input.botIsAddressed ? 'direct casual turn' : 'no clear value to add passively',
    });
  }

  private turn(evaluation: TurnEvaluation): TurnEvaluation {
    return {
      ...evaluation,
      providerRequests: uniq(evaluation.providerRequests),
      confidence: Math.max(0, Math.min(1, evaluation.confidence)),
    };
  }

  private looksLikeClaim(message: string): boolean {
    const words = message.trim().split(/\s+/).filter(Boolean);
    if (words.length < 4) return false;
    if (message.includes('?')) return false;
    if (WRONGNESS_RE.test(message)) return true;
    return CLAIM_MARKER_RE.test(message) || /\b20(2[0-9]|3[0-9])\b/.test(message);
  }

  private threadChallengesClaim(input: TurnEvaluatorInput): boolean {
    const recent = input.history
      .slice(-4)
      .map((m) => m.message.messageText ?? '')
      .join(' ');
    return WRONGNESS_RE.test(recent);
  }

  private recentlyCriticized(input: TurnEvaluatorInput): boolean {
    return input.recentBotReplies.some((r) => (r.feedbackScore ?? 0) < 0);
  }
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}
