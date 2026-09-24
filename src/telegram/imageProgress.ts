import type { Api } from 'grammy';
import { escapeHtml } from '../utils/text.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('image-progress');
const MIN_UPDATE_INTERVAL_MS = 1200;

/**
 * Format a visual progress bar with unicode block elements:
 * e.g. [░░░░░░░░░░] 0%, [████░░░░░░] 40%, [██████████] 100%
 */
export function formatProgressBar(percent: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const filledCount = Math.max(0, Math.min(width, Math.round((clamped / 100) * width)));
  const emptyCount = width - filledCount;
  const bar = '█'.repeat(filledCount) + '░'.repeat(emptyCount);
  return `[${bar}] ${clamped}%`;
}

export interface ImageProgressOptions {
  api: Pick<Api, 'sendMessage' | 'editMessageText' | 'deleteMessage'>;
  chatId: number;
  replyToMessageId?: number;
  prefix?: string;
  initialPrompt?: string;
}

/**
 * Progress reporter for image generation in Telegram.
 * Sends an initial status message with the prompt in monospace (copyable)
 * and an advancing progress bar, updates it throttled in-place,
 * and deletes it upon completion so only the delivered image remains.
 */
export class ImageProgressReporter {
  private messageId: number | undefined;
  private currentPrompt = '';
  private lastSentAt = 0;
  private pendingText: string | undefined;
  private flushing = false;
  private disabled = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: ImageProgressOptions) {
    this.currentPrompt = options.initialPrompt ?? '';
  }

  get id(): number | undefined {
    return this.messageId;
  }

  async start(prompt?: string): Promise<void> {
    if (this.disabled) return;
    if (prompt) this.currentPrompt = prompt;
    const text = this.renderText(0);
    try {
      const sent = await this.options.api.sendMessage(this.options.chatId, text, {
        parse_mode: 'HTML',
        ...(this.options.replyToMessageId
          ? { reply_parameters: { message_id: this.options.replyToMessageId } }
          : {}),
      });
      this.messageId = sent.message_id;
      this.lastSentAt = Date.now();
      if (this.pendingText !== undefined && !this.flushing) {
        void this.flush();
      }
    } catch (err) {
      log.warn({ err, chatId: this.options.chatId }, 'failed to send initial image progress message');
      this.disabled = true;
    }
  }

  async update(percent: number, prompt?: string, stage?: string): Promise<void> {
    if (this.disabled) return;
    if (prompt) this.currentPrompt = prompt;
    const text = this.renderText(percent, stage);
    this.pendingText = text;

    if (!this.messageId) {
      return;
    }

    const now = Date.now();
    const elapsed = now - this.lastSentAt;
    if (elapsed >= MIN_UPDATE_INTERVAL_MS) {
      await this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, MIN_UPDATE_INTERVAL_MS - elapsed);
    }
  }

  async delete(): Promise<void> {
    this.disabled = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.messageId !== undefined) {
      const msgId = this.messageId;
      this.messageId = undefined;
      try {
        await this.options.api.deleteMessage(this.options.chatId, msgId);
      } catch (err) {
        log.debug({ err, chatId: this.options.chatId, msgId }, 'failed to delete image progress message');
      }
    }
  }

  private renderText(percent: number, stage?: string): string {
    const prefix = this.options.prefix ?? "Sto generando un'immagine";
    const bar = formatProgressBar(percent);
    const cleanPrompt = this.currentPrompt.trim();
    const promptSection = cleanPrompt
      ? `${prefix} con prompt:\n<code>${escapeHtml(cleanPrompt)}</code>\n\n`
      : `${prefix}...\n\n`;
    const stageSuffix = stage ? ` · ${escapeHtml(stage)}` : '';
    return `${promptSection}⏳ ${bar}${stageSuffix}`;
  }

  private async flush(): Promise<void> {
    if (this.flushing || !this.messageId || this.pendingText === undefined || this.disabled) return;
    this.flushing = true;
    const text = this.pendingText;
    this.pendingText = undefined;
    try {
      await this.options.api.editMessageText(this.options.chatId, this.messageId, text, {
        parse_mode: 'HTML',
      });
      this.lastSentAt = Date.now();
    } catch (err) {
      log.debug({ err, chatId: this.options.chatId, messageId: this.messageId }, 'failed to edit image progress message');
    } finally {
      this.flushing = false;
      if (this.pendingText !== undefined && !this.disabled && !this.timer) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.flush();
        }, MIN_UPDATE_INTERVAL_MS);
      }
    }
  }
}
