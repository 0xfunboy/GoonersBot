import { randomBytes } from 'node:crypto';
import type { Collection, Db } from 'mongodb';
import type { SocialFacetKind } from '../../social/types.js';

export type SocialQuestionKind = 'clarification' | 'curiosity';
export type SocialQuestionState = 'pending' | 'answered' | 'declined' | 'cancelled';

export interface SocialQuestionDoc {
  id: string;
  chatId: number;
  threadId: number | null;
  targetHandle: string;
  targetTelegramId: number | null;
  /** Person whose profile/fact the answer is about. Usually the target, but clarification may ask A about B. */
  subjectHandle: string | null;
  kind: SocialQuestionKind;
  questionText: string;
  facet: SocialFacetKind | null;
  key: string | null;
  candidates: string[];
  reason: string;
  botMessageId: number | null;
  state: SocialQuestionState;
  answerMessageId: number | null;
  resolvedValue: string | null;
  resolutionConfidence: number | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  answeredAt: Date | null;
}

export interface CreateSocialQuestionInput {
  chatId: number;
  threadId?: number | null;
  targetHandle: string;
  targetTelegramId?: number | null;
  subjectHandle?: string | null;
  kind: SocialQuestionKind;
  questionText: string;
  facet?: SocialFacetKind | null;
  key?: string | null;
  candidates?: string[];
  reason: string;
  expiresAt: Date;
}

export class SocialQuestionsRepo {
  private readonly col: Collection<SocialQuestionDoc>;

  constructor(db: Db) {
    this.col = db.collection<SocialQuestionDoc>('social_questions');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<SocialQuestionDoc>('social_questions');
    await col.createIndex({ id: 1 }, { unique: true });
    await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await col.createIndex({ chatId: 1, botMessageId: 1 });
    await col.createIndex({
      chatId: 1,
      targetHandle: 1,
      threadId: 1,
      state: 1,
      createdAt: -1,
    });
  }

  async create(input: CreateSocialQuestionInput, now = new Date()): Promise<SocialQuestionDoc> {
    // Only one open question per target/topic. Humans do not interrogate people with three pending
    // forms at once, and this makes unquoted follow-up answers deterministic.
    await this.col.updateMany(
      {
        chatId: input.chatId,
        targetHandle: input.targetHandle,
        threadId: input.threadId ?? null,
        state: 'pending',
      },
      { $set: { state: 'cancelled', updatedAt: now } },
    );
    const doc: SocialQuestionDoc = {
      id: `sq_${randomBytes(18).toString('base64url')}`,
      chatId: input.chatId,
      threadId: input.threadId ?? null,
      targetHandle: input.targetHandle,
      targetTelegramId: input.targetTelegramId ?? null,
      subjectHandle: input.subjectHandle ?? input.targetHandle,
      kind: input.kind,
      questionText: input.questionText.trim().slice(0, 700),
      facet: input.facet ?? null,
      key: input.key?.trim().slice(0, 100) ?? null,
      candidates: [
        ...new Set((input.candidates ?? []).map((value) => value.trim()).filter(Boolean)),
      ].slice(0, 8),
      reason: input.reason.trim().slice(0, 500),
      botMessageId: null,
      state: 'pending',
      answerMessageId: null,
      resolvedValue: null,
      resolutionConfidence: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt,
      answeredAt: null,
    };
    await this.col.insertOne(doc);
    return doc;
  }

  async attachMessage(
    id: string,
    botMessageId: number,
    now = new Date(),
  ): Promise<SocialQuestionDoc | null> {
    return this.col.findOneAndUpdate(
      { id, state: 'pending', expiresAt: { $gt: now } },
      { $set: { botMessageId, updatedAt: now } },
      { returnDocument: 'after' },
    );
  }

  async findPendingForAnswer(params: {
    chatId: number;
    threadId?: number | null;
    targetHandle: string;
    replyToMessageId?: number | null;
    now?: Date;
  }): Promise<SocialQuestionDoc | null> {
    const now = params.now ?? new Date();
    if (params.replyToMessageId != null) {
      const exact = await this.col.findOne({
        chatId: params.chatId,
        botMessageId: params.replyToMessageId,
        targetHandle: params.targetHandle,
        state: 'pending',
        expiresAt: { $gt: now },
      });
      if (exact) return exact;
    }
    return this.col.findOne(
      {
        chatId: params.chatId,
        threadId: params.threadId ?? null,
        targetHandle: params.targetHandle,
        state: 'pending',
        botMessageId: { $ne: null },
        expiresAt: { $gt: now },
      },
      { sort: { createdAt: -1 } },
    );
  }

  async hasRecentQuestion(params: {
    chatId: number;
    targetHandle: string;
    since: Date;
  }): Promise<boolean> {
    return Boolean(
      await this.col.findOne(
        {
          chatId: params.chatId,
          targetHandle: params.targetHandle,
          botMessageId: { $ne: null },
          createdAt: { $gte: params.since },
        },
        { projection: { _id: 1 } },
      ),
    );
  }

  async resolve(
    id: string,
    state: 'answered' | 'declined',
    params: {
      answerMessageId?: number | null;
      resolvedValue?: string | null;
      confidence?: number | null;
      now?: Date;
    } = {},
  ): Promise<SocialQuestionDoc | null> {
    const now = params.now ?? new Date();
    return this.col.findOneAndUpdate(
      { id, state: 'pending', expiresAt: { $gt: now } },
      {
        $set: {
          state,
          answerMessageId: params.answerMessageId ?? null,
          resolvedValue: params.resolvedValue?.trim().slice(0, 300) ?? null,
          resolutionConfidence:
            params.confidence == null ? null : Math.max(0, Math.min(1, params.confidence)),
          answeredAt: now,
          updatedAt: now,
        },
      },
      { returnDocument: 'after' },
    );
  }
}
