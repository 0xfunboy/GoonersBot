import type { ChatContext, IncomingMessage, Person, TranscribedMessage } from '../domain/types.js';
import type { LLMProvider } from '../providers/llm/types.js';
import type { MediaProcessor } from '../providers/media/index.js';
import type { ConversationService } from './conversation.js';
import type { FactService } from './facts.js';
import { BOT_LABEL } from './conversation.js';
import {
  buildReplyUserPrompt,
  buildSystemPrompt,
  buildFactExtractionContext,
} from '../prompts/index.js';
import { isRefusal } from './modelRouter.js';
import type { ChatRequest, ChatResult } from '../providers/llm/types.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('reply');

export interface ReplyContext {
  person: Person;
  context: ChatContext;
  message: IncomingMessage;
  botUsername: string;
  language: string;
  modeName: string;
  modeDescription: string;
  /** model to use for this turn (from ModelRouter); undefined => provider default */
  model?: string | undefined;
  /** treat this turn as NSFW (relaxes system prompt) */
  nsfw?: boolean | undefined;
  /** NSFW model to upgrade to if the default model refuses (buffered backstop) */
  nsfwModel?: string | undefined;
  /** arm the buffered refusal backstop for this turn */
  allowRefusalFallback?: boolean | undefined;
  /** how many leading chars to buffer before deciding refusal */
  refusalBufferChars?: number | undefined;
}

export interface ReplyResult {
  text: string;
  imageUrl?: string;
  imageBuffer?: Buffer;
  transcribedUserMessage: TranscribedMessage;
  usage: { inputTokens: number; outputTokens: number; estimated: boolean };
  model: string | null;
  visionCalls: number;
  transcriptionCalls: number;
  imageCalls: number;
}

/** Heuristic: does the user explicitly ask for an image? Gates the (capability-bound) image path. */
const IMAGE_REQUEST_RE =
  /\b(draw|generate (an )?image|make (an? )?(image|pic|picture|meme)|create (an? )?(image|pic)|paint|render (an? )?image)\b/i;

export class ReplyService {
  constructor(
    private readonly llm: LLMProvider,
    private readonly media: MediaProcessor,
    private readonly conversation: ConversationService,
    private readonly facts: FactService,
    private readonly maxReplyTokens: number,
  ) {}

  /** Transcribe any attached media into a text-described message. */
  async transcribe(message: IncomingMessage): Promise<{
    transcribed: TranscribedMessage;
    visionCalls: number;
    transcriptionCalls: number;
  }> {
    let imageDescription: string | null = null;
    let voiceDescription: string | null = null;
    let visionCalls = 0;
    let transcriptionCalls = 0;

    if (message.imageBuffer) {
      imageDescription = await this.media.describeImage(
        message.imageBuffer,
        message.imageMime ?? 'image/jpeg',
      );
      if (imageDescription !== null) visionCalls = 1;
    }
    if (message.audioBuffer) {
      voiceDescription = await this.media.transcribeVoice(
        message.audioBuffer,
        message.audioMime ?? 'audio/ogg',
        'voice.ogg',
      );
      if (voiceDescription !== null) transcriptionCalls = 1;
    }

    return {
      transcribed: {
        messageText: message.messageText || null,
        timestamp: message.timestamp,
        imageDescription,
        voiceDescription,
      },
      visionCalls,
      transcriptionCalls,
    };
  }

  /**
   * Stream a reply. Yields incremental text; returns the final ReplyResult (including an optional
   * generated image when the user asked for one and the capability exists).
   */
  async *streamReply(ctx: ReplyContext): AsyncGenerator<string, ReplyResult, void> {
    const { transcribed, visionCalls, transcriptionCalls } = await this.transcribe(ctx.message);

    const [history, groupFacts, userFacts, introduction] = await Promise.all([
      this.conversation.getRecent(ctx.context.chatId),
      this.facts.getChatFacts(ctx.context.chatId),
      this.facts.getForUser(ctx.context.chatId, ctx.person.userHandle),
      this.facts.getIntroduction(ctx.context.chatId, ctx.person.userHandle),
    ]);

    const userPrompt = buildReplyUserPrompt({
      person: ctx.person,
      message: transcribed,
      history,
      groupFacts,
      userFacts,
      introduction,
      botLabel: BOT_LABEL,
    });

    const buildReq = (model: string | undefined, nsfw: boolean): ChatRequest => ({
      system: buildSystemPrompt({
        botUsername: ctx.botUsername,
        chatName: ctx.context.chatName,
        language: ctx.language,
        modeName: ctx.modeName,
        modeDescription: ctx.modeDescription,
        nsfw,
      }),
      messages: [{ role: 'user', content: userPrompt }],
      temperature: 0.8,
      maxTokens: this.maxReplyTokens,
      ...(model ? { model } : {}),
    });

    let text = '';
    let final: ChatResult;
    const fallbackArmed = Boolean(
      ctx.allowRefusalFallback && ctx.nsfwModel && ctx.model !== ctx.nsfwModel,
    );

    if (fallbackArmed) {
      // Buffer the opening of the default-model reply; if it's a refusal, silently switch to the
      // NSFW model and restart. Only the first ~buffer chars are withheld, so latency cost is tiny
      // and the user never sees the refusal.
      const bufN = ctx.refusalBufferChars ?? 160;
      const stream = this.llm.streamChatCompletion(buildReq(ctx.model, ctx.nsfw ?? false));
      let buffer = '';
      let decided = false;
      let refused = false;
      let pendingFinal: ChatResult | null = null;
      let n = await stream.next();
      while (!n.done) {
        buffer += n.value;
        if (!decided && buffer.length >= bufN) {
          decided = true;
          if (isRefusal(buffer)) {
            refused = true;
            break;
          }
          text += buffer;
          yield buffer;
          buffer = '';
        } else if (decided) {
          text += n.value;
          yield n.value;
        }
        n = await stream.next();
      }
      if (!refused) {
        pendingFinal = n.done ? n.value : null;
        if (!decided) {
          // stream ended before the buffer threshold (short reply)
          if (isRefusal(buffer)) {
            refused = true;
          } else if (buffer) {
            text += buffer;
            yield buffer;
          }
        }
      }
      if (refused) {
        log.info('default model refused — upgrading turn to the NSFW model');
        text = '';
        const ns = this.llm.streamChatCompletion(buildReq(ctx.nsfwModel, true));
        let m = await ns.next();
        while (!m.done) {
          text += m.value;
          yield m.value;
          m = await ns.next();
        }
        pendingFinal = m.value;
      }
      final = pendingFinal ?? { text, model: ctx.model ?? '', usage: { estimated: true } };
    } else {
      const stream = this.llm.streamChatCompletion(buildReq(ctx.model, ctx.nsfw ?? false));
      let n = await stream.next();
      while (!n.done) {
        text += n.value;
        yield n.value;
        n = await stream.next();
      }
      final = n.value;
    }

    text = final.text || text;
    const usage = {
      inputTokens: final.usage.inputTokens ?? 0,
      outputTokens: final.usage.outputTokens ?? 0,
      estimated: final.usage.estimated,
    };
    const model: string | null = final.model || null;

    // Optional image output: only when explicitly requested AND capability exists.
    let imageUrl: string | undefined;
    let imageBuffer: Buffer | undefined;
    let imageCalls = 0;
    const wantsImage = IMAGE_REQUEST_RE.test(ctx.message.messageText || '');
    if (wantsImage && this.media.canGenerateImage) {
      const img = await this.media.generateImage(ctx.message.messageText);
      if (img) {
        imageCalls = 1;
        if (img.url) imageUrl = img.url;
        if (img.buffer) imageBuffer = img.buffer;
      }
    }

    const result: ReplyResult = {
      text,
      transcribedUserMessage: transcribed,
      usage,
      model,
      visionCalls,
      transcriptionCalls,
      imageCalls,
    };
    if (imageUrl !== undefined) result.imageUrl = imageUrl;
    if (imageBuffer !== undefined) result.imageBuffer = imageBuffer;
    return result;
  }

  /**
   * Extract durable facts from the latest exchange (called when /autofact is ON).
   * Persists accepted facts and returns how many were stored.
   */
  async extractAndStoreFacts(
    chatId: number,
    userHandle: string,
    latestMessage: string,
    botReply: string,
  ): Promise<number> {
    try {
      const history = await this.conversation.getRecent(chatId);
      const existing = (await this.facts.getChatFacts(chatId)).map((f) => `${f.handle}: ${f.fact}`);
      const context = buildFactExtractionContext({
        userHandle,
        latestMessage,
        botReply,
        history,
        botLabel: BOT_LABEL,
      });
      const facts = await this.llm.extractFacts({ context, existingFacts: existing });
      let stored = 0;
      for (const f of facts) {
        await this.facts.addAutoFact(chatId, f.userHandle, f.fact);
        stored += 1;
      }
      if (stored > 0) log.info({ chatId, stored }, 'auto-extracted facts');
      return stored;
    } catch (err) {
      log.warn({ err }, 'fact extraction failed');
      return 0;
    }
  }
}
