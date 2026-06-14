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

    const system = buildSystemPrompt({
      botUsername: ctx.botUsername,
      chatName: ctx.context.chatName,
      language: ctx.language,
      modeName: ctx.modeName,
      modeDescription: ctx.modeDescription,
    });
    const userPrompt = buildReplyUserPrompt({
      person: ctx.person,
      message: transcribed,
      history,
      groupFacts,
      userFacts,
      introduction,
      botLabel: BOT_LABEL,
    });

    let text = '';
    let usage = { inputTokens: 0, outputTokens: 0, estimated: true };
    let model: string | null = null;
    const stream = this.llm.streamChatCompletion({
      system,
      messages: [{ role: 'user', content: userPrompt }],
      temperature: 0.8,
      maxTokens: this.maxReplyTokens,
    });
    let next = await stream.next();
    while (!next.done) {
      text += next.value;
      yield next.value;
      next = await stream.next();
    }
    const final = next.value;
    text = final.text || text;
    usage = {
      inputTokens: final.usage.inputTokens ?? 0,
      outputTokens: final.usage.outputTokens ?? 0,
      estimated: final.usage.estimated,
    };
    model = final.model;

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
