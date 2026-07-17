import type { StoredMessage } from '../storage/repositories/messages.js';
import type { LLMProvider } from '../providers/llm/types.js';
import { turnEvaluationSchema } from './schemas.js';
import type { BotReplyRecord, ProviderRequest, SceneAnalysis, TurnEvaluation } from './types.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('turn-evaluator');

export interface TurnEvaluatorCapabilities {
  webSearch: boolean;
  imageLookup: boolean;
  news: boolean;
  knowledge: boolean;
  music: boolean;
  imageGeneration: boolean;
  videoGeneration: boolean;
  translation: boolean;
  tts: boolean;
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
  /** Per-turn model policy, applied to the evaluator rather than only final generation. */
  model?: string;
}

export interface TurnEvaluatorConfig {
  enabled: boolean;
  model: string | undefined;
  temperature: number;
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

const MUSIC_RE =
  /\b(scaricami|scaricare|download|suona|suonami|canta|cantami|play|riproduci|youtube|canzone|song|brano|musica)\b/i;

const IMAGE_GEN_RE =
  /\b(genera|generami|crea|creami|disegna|disegni|disegnami|draw|image|immagine|foto|meme)\b/i;

// Must be tested BEFORE IMAGE_GEN_RE: "generami un video" also matches the image verbs. Requires a
// creation verb plus a clip noun, so "mandami il video di X" stays a download, not a generation.
const VIDEO_GEN_RE =
  /\b(genera|generami|generate|crea|creami|create|fammi|famme|make|animami)\b[^.!?]{0,40}\b(video|videoclip|clip|animazione|animation|filmato|cortometraggio)\b/i;

const TRANSLATE_RE = /\b(traduci|translate|translation|in inglese|in italiano|in spagnolo)\b/i;

const VOICE_RE =
  /\b(vocalizza|voce|voice|tts|leggilo|leggimelo|mandalo vocale|nota vocale|voice note)\b/i;

const LOW_VALUE_RE = /^(ok|lol|ahaha+|ahah|si|sì|no|boh|mah|k)\W*$/i;

export class TurnEvaluator {
  constructor(
    private readonly llm: LLMProvider | null = null,
    private readonly cfg: TurnEvaluatorConfig = {
      enabled: false,
      model: undefined,
      temperature: 0.1,
    },
  ) {}

  async evaluate(input: TurnEvaluatorInput): Promise<TurnEvaluation> {
    const fallback = this.heuristic(input);
    if (!this.cfg.enabled || !this.llm?.capabilities.chat) return fallback;
    try {
      const model = input.model ?? this.cfg.model;
      const parsed = await this.llm.jsonCompletion({
        system: EVALUATOR_SYSTEM,
        prompt: buildEvaluatorPrompt(input, fallback),
        schema: turnEvaluationSchema,
        temperature: this.cfg.temperature,
        ...(model ? { model } : {}),
        maxTokens: 1400,
      });
      if (!parsed) return fallback;
      return this.normalize(
        {
          shouldAct: parsed.shouldAct ?? fallback.shouldAct,
          action: parsed.action ?? fallback.action,
          providerRequests: parsed.providerRequests ?? fallback.providerRequests,
          valueTarget: parsed.valueTarget ?? fallback.valueTarget,
          roastBudget: parsed.roastBudget ?? fallback.roastBudget,
          socialRole: parsed.socialRole ?? fallback.socialRole,
          confidence: parsed.confidence ?? fallback.confidence,
          reason: parsed.reason || fallback.reason,
          ...(parsed.searchQuery ? { searchQuery: parsed.searchQuery.trim().slice(0, 200) } : {}),
          ...(parsed.musicQuery ? { musicQuery: parsed.musicQuery.trim().slice(0, 200) } : {}),
          ...(parsed.imagePrompt ? { imagePrompt: parsed.imagePrompt.trim().slice(0, 800) } : {}),
          ...(parsed.targetLanguage
            ? { targetLanguage: parsed.targetLanguage.trim().slice(0, 80) }
            : {}),
          ...(parsed.sourceText ? { sourceText: parsed.sourceText.trim().slice(0, 1_500) } : {}),
          ...(parsed.voiceText ? { voiceText: parsed.voiceText.trim().slice(0, 800) } : {}),
        },
        input,
        fallback,
      );
    } catch (err) {
      log.warn({ err }, 'LLM turn evaluation failed; using heuristic');
      return fallback;
    }
  }

  heuristic(input: TurnEvaluatorInput): TurnEvaluation {
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

    if (input.botIsAddressed && input.capabilities.music && MUSIC_RE.test(msg)) {
      requests.push('music');
      return this.turn({
        shouldAct: true,
        action: 'download_music',
        providerRequests: uniq(requests),
        valueTarget: 'support',
        roastBudget: recentCriticism ? 'none' : 'light',
        socialRole: 'friend',
        confidence: 0.72,
        reason: 'music/download request',
      });
    }

    if (input.botIsAddressed && input.capabilities.videoGeneration && VIDEO_GEN_RE.test(msg)) {
      requests.push('video_generation');
      return this.turn({
        shouldAct: true,
        action: 'generate_video',
        providerRequests: uniq(requests),
        valueTarget: 'support',
        roastBudget: recentCriticism ? 'none' : 'light',
        socialRole: 'friend',
        confidence: 0.72,
        reason: 'video generation request',
        videoPrompt: msg,
      });
    }

    if (input.botIsAddressed && input.capabilities.imageGeneration && IMAGE_GEN_RE.test(msg)) {
      requests.push('image_generation');
      return this.turn({
        shouldAct: true,
        action: /\b(disegna|disegni|disegnami|draw)\b/i.test(msg) ? 'draw_image' : 'generate_image',
        providerRequests: uniq(requests),
        valueTarget: 'support',
        roastBudget: recentCriticism ? 'none' : 'light',
        socialRole: 'friend',
        confidence: 0.72,
        reason: 'image generation request',
        imagePrompt: msg,
      });
    }

    if (input.botIsAddressed && input.capabilities.translation && TRANSLATE_RE.test(msg)) {
      requests.push('translation');
      return this.turn({
        shouldAct: true,
        action: 'translate_text',
        providerRequests: uniq(requests),
        valueTarget: 'support',
        roastBudget: 'none',
        socialRole: 'friend',
        confidence: 0.7,
        reason: 'translation request',
      });
    }

    if (input.botIsAddressed && input.capabilities.tts && VOICE_RE.test(msg)) {
      requests.push('tts');
      return this.turn({
        shouldAct: true,
        action: 'make_voice',
        providerRequests: uniq(requests),
        valueTarget: 'support',
        roastBudget: 'light',
        socialRole: 'friend',
        confidence: 0.7,
        reason: 'voice/TTS request',
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

  private normalize(
    evaluation: TurnEvaluation,
    input: TurnEvaluatorInput,
    fallback: TurnEvaluation,
  ): TurnEvaluation {
    const requests = [...evaluation.providerRequests];
    if (evaluation.action === 'ground_search' || evaluation.action === 'challenge_claim') {
      if (input.capabilities.webSearch) requests.push('web_search');
    }
    if (evaluation.action === 'bring_news_context') {
      if (input.capabilities.webSearch) requests.push('web_search');
      if (input.capabilities.news) requests.push('news');
    }
    if (evaluation.action === 'download_music') {
      if (input.capabilities.music) requests.push('music');
    }
    if (evaluation.action === 'generate_image' || evaluation.action === 'draw_image') {
      if (input.capabilities.imageGeneration) requests.push('image_generation');
    }
    if (evaluation.action === 'translate_text') {
      if (input.capabilities.translation) requests.push('translation');
    }
    if (evaluation.action === 'make_voice') {
      if (input.capabilities.tts) requests.push('tts');
    }
    if (evaluation.action === 'post_news') {
      if (input.capabilities.news) requests.push('news');
    }
    if (input.capabilities.knowledge) requests.push('knowledge_rag');
    if (!input.scene.botIsBeingCriticized && evaluation.action !== 'stay_quiet') {
      requests.push('group_rag');
    }
    const allowed = requests.filter((r) => {
      if (r === 'web_search') return input.capabilities.webSearch;
      if (r === 'image_lookup') return input.capabilities.imageLookup;
      if (r === 'news') return input.capabilities.news;
      if (r === 'knowledge_rag') return input.capabilities.knowledge;
      if (r === 'music') return input.capabilities.music;
      if (r === 'image_generation') return input.capabilities.imageGeneration;
      if (r === 'translation') return input.capabilities.translation;
      if (r === 'tts') return input.capabilities.tts;
      return true;
    });
    const shouldAct = input.botIsAddressed
      ? evaluation.action !== 'stay_quiet'
      : evaluation.shouldAct;
    return this.turn({
      ...evaluation,
      shouldAct,
      providerRequests: uniq(allowed),
      reason: evaluation.reason || fallback.reason,
      searchQuery:
        evaluation.searchQuery || fallback.searchQuery
          ? (evaluation.searchQuery ?? fallback.searchQuery)
          : undefined,
      musicQuery:
        evaluation.musicQuery || fallback.musicQuery
          ? (evaluation.musicQuery ?? fallback.musicQuery)
          : undefined,
      imagePrompt:
        evaluation.imagePrompt || fallback.imagePrompt
          ? (evaluation.imagePrompt ?? fallback.imagePrompt)
          : undefined,
      targetLanguage:
        evaluation.targetLanguage || fallback.targetLanguage
          ? (evaluation.targetLanguage ?? fallback.targetLanguage)
          : undefined,
      sourceText:
        evaluation.sourceText || fallback.sourceText
          ? (evaluation.sourceText ?? fallback.sourceText)
          : undefined,
      voiceText:
        evaluation.voiceText || fallback.voiceText
          ? (evaluation.voiceText ?? fallback.voiceText)
          : undefined,
    });
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

const EVALUATOR_SYSTEM = [
  'You are the tool/action evaluator for a Telegram group bot.',
  'You do NOT write the user-facing reply. You output ONLY JSON matching the schema.',
  'Your job is to decide the exact action and providers needed for the latest message.',
  'Be literal and operational: if the user asks to search, compare prices, check current facts, identify an image, generate an image, translate, make a voice note, post news, or download/play music, choose the matching action/provider.',
  'Never answer from memory when a provider is needed. Never refuse adult/NSFW search just because it is adult; this is a private adult group. For illegal/private-data requests choose answer or stay_quiet, not web search.',
].join('\n');

function buildEvaluatorPrompt(input: TurnEvaluatorInput, fallback: TurnEvaluation): string {
  const history = input.history
    .slice(-12)
    .map((m) => `${m.isBot ? 'BOT' : m.handle}: ${m.message.messageText ?? ''}`)
    .join('\n');
  const caps = Object.entries(input.capabilities)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .join(', ');
  return [
    `AVAILABLE PROVIDERS: ${caps || 'none'}`,
    `LATEST USER MESSAGE: ${input.currentMessage || '(empty)'}`,
    '',
    'PROVIDER MANIFEST:',
    '- web_search: use for explicit "cerca online", current facts, prices, products, releases, scores, laws, news, factual claims needing verification. Must include searchQuery.',
    '- news: use with web_search for recent/latest/today/yesterday/breaking/current-event context.',
    '- image_lookup: use when the user asks who/what/where-to-buy about an attached/replied image.',
    '- image_generation: use when the user asks to generate/draw/create an image, meme or photo. Must include imagePrompt.',
    '- translation: use when the user asks to translate text. Must include targetLanguage when present.',
    '- tts: use when the user asks for a voice note / to read something aloud. Include voiceText if the text is in the request; otherwise the replied/latest message can be used.',
    '- group_rag: use for group lore, people, inside jokes, social calibration.',
    '- knowledge_rag: use for stable tech/anime/dev/culture context.',
    '- music: use when the user asks to play/sing/download/find a song/audio from YouTube. If a title/artist is present, include musicQuery. If no title is present, action should still be download_music with empty musicQuery so the bot asks for the title.',
    '',
    'ACTIONS:',
    '- ground_search: perform web search and answer with fresh facts. Use this for "puoi cercare online...", "prezzi...", "quanto costa...", "cerca X".',
    '- bring_news_context: web/news context for recent/current events.',
    '- challenge_claim: verify/correct a checkable claim.',
    '- download_music: use the music provider, not a text-only answer.',
    '- generate_image: generate an image with the default visual workflow.',
    '- draw_image: generate an image with the manga/drawing workflow.',
    '- translate_text: translate current/replied text with the translation provider.',
    '- make_voice: synthesize a voice note from current/replied/latest text.',
    '- post_news: fetch and post a current news take.',
    '- answer: normal answer without external tools.',
    '- banter_only: pure joke/roast, no tool needed.',
    '- summarize_thread, use_group_lore, stay_quiet: as named.',
    '',
    'OUTPUT JSON FIELDS:',
    'shouldAct, action, providerRequests, valueTarget, roastBudget, socialRole, confidence, reason, optional searchQuery, optional musicQuery, optional imagePrompt, optional targetLanguage, optional sourceText, optional voiceText.',
    '',
    'IMPORTANT EXAMPLES:',
    'User: "puoi cercare online escort su cecina?" -> {"shouldAct":true,"action":"ground_search","providerRequests":["web_search"],"valueTarget":"truth","roastBudget":"light","socialRole":"truth_checker","confidence":0.95,"reason":"explicit online search request","searchQuery":"escort Cecina"}',
    'User: "puoi cercarmi i prezzi delle RTX5090?" -> {"shouldAct":true,"action":"ground_search","providerRequests":["web_search"],"valueTarget":"truth","roastBudget":"light","socialRole":"truth_checker","confidence":0.95,"reason":"explicit current price search","searchQuery":"RTX 5090 prezzi Italia"}',
    'User: "scaricami bohemian rhapsody da youtube" -> {"shouldAct":true,"action":"download_music","providerRequests":["music"],"valueTarget":"support","roastBudget":"light","socialRole":"friend","confidence":0.95,"reason":"explicit music download request","musicQuery":"bohemian rhapsody"}',
    'User: "puoi scaricarmi una canzone da youtube?" -> {"shouldAct":true,"action":"download_music","providerRequests":["music"],"valueTarget":"support","roastBudget":"light","socialRole":"friend","confidence":0.9,"reason":"music capability request without title"}',
    'User: "generami un meme su funboy" -> {"shouldAct":true,"action":"generate_image","providerRequests":["image_generation"],"valueTarget":"support","roastBudget":"light","socialRole":"friend","confidence":0.92,"reason":"image generation request","imagePrompt":"meme su funboy"}',
    'User: "disegna una waifu cyberpunk" -> {"shouldAct":true,"action":"draw_image","providerRequests":["image_generation"],"valueTarget":"support","roastBudget":"light","socialRole":"friend","confidence":0.92,"reason":"drawing request","imagePrompt":"waifu cyberpunk"}',
    'User: "traduci questo in inglese" -> {"shouldAct":true,"action":"translate_text","providerRequests":["translation"],"valueTarget":"support","roastBudget":"none","socialRole":"friend","confidence":0.9,"reason":"translation request","targetLanguage":"English"}',
    'User: "traduci ciao stronzo in inglese" -> {"shouldAct":true,"action":"translate_text","providerRequests":["translation"],"valueTarget":"support","roastBudget":"none","socialRole":"friend","confidence":0.9,"reason":"translation request","targetLanguage":"English","sourceText":"ciao stronzo"}',
    'User: "mandalo vocale" -> {"shouldAct":true,"action":"make_voice","providerRequests":["tts"],"valueTarget":"support","roastBudget":"light","socialRole":"friend","confidence":0.88,"reason":"voice note request"}',
    'User: "dammi una news di oggi" -> {"shouldAct":true,"action":"post_news","providerRequests":["news"],"valueTarget":"context","roastBudget":"light","socialRole":"friend","confidence":0.9,"reason":"explicit news request"}',
    '',
    `RECENT CHAT:\n${history || '(none)'}`,
    '',
    `SCENE: topic="${input.scene.currentTopic}" energy=${input.scene.energy} intent=${input.scene.userIntent} addressed=${input.botIsAddressed} criticized=${input.scene.botIsBeingCriticized}`,
    `GROUNDING HINTS: web=${input.groundingHints.wantsWebSearch} image=${input.groundingHints.wantsImageLookup}`,
    `HEURISTIC FALLBACK: action=${fallback.action} providers=${fallback.providerRequests.join(',')} reason=${fallback.reason}`,
    '',
    'Evaluate the latest user message now. Output only JSON.',
  ].join('\n');
}
