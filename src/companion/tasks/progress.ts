import type { Api } from 'grammy';
import { childLogger } from '../../utils/logger.js';

const log = childLogger('companion-task-progress');
const MIN_UPDATE_INTERVAL_MS = 1200;
const TELEGRAM_REQUEST_TIMEOUT_MS = 4000;

/**
 * Format a visual progress bar with unicode block elements:
 * e.g. [██████████] 100% or [█████░░░░░] 50%
 */
export function formatProgressBar(percent: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const filledCount = Math.max(0, Math.min(width, Math.round((clamped / 100) * width)));
  const emptyCount = width - filledCount;
  const bar = '█'.repeat(filledCount) + '░'.repeat(emptyCount);
  return `[${bar}] ${clamped}%`;
}

export interface CompanionProgressOptions {
  chatId: number;
  messageId: number;
  threadId?: number;
  language?: string;
  header?: string;
}

/**
 * In-place progress reporter for companion tasks.
 * Edits the initial acknowledgment message with an advancing progress bar,
 * avoiding spam in the Telegram chat, and deletes the progress message
 * upon task completion once results are delivered.
 */
export class CompanionTaskProgressReporter {
  private lastText = '';
  private pendingText: string | undefined;
  private lastSentAt = 0;
  private flushing = false;
  private disabled = false;
  private throttleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly api: Pick<Api, 'editMessageText' | 'deleteMessage'>,
    private readonly options: CompanionProgressOptions,
  ) {}

  get messageId(): number {
    return this.options.messageId;
  }

  /**
   * Update progress percentage and current stage description in-place.
   */
  async update(percent: number, stageDescription: string): Promise<void> {
    if (this.disabled) return;
    const bar = formatProgressBar(percent);
    const header = this.options.header ? `${this.options.header}\n\n` : 'Me ne sto occupando.\n\n';
    const text = `${header}⏳ ${bar} · ${stageDescription}`;
    await this.write(text);
  }

  /**
   * Called when task delivery completes.
   * Deletes the progress message so only final results remain in chat.
   */
  async complete(): Promise<void> {
    this.disabled = true;
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = undefined;
    }
    this.pendingText = undefined;
    try {
      await this.api.deleteMessage(this.options.chatId, this.options.messageId);
      log.debug(
        { chatId: this.options.chatId, messageId: this.options.messageId },
        'progress message deleted on task completion',
      );
    } catch (error) {
      log.debug(
        { error, chatId: this.options.chatId, messageId: this.options.messageId },
        'could not delete progress message on completion (permission or expired)',
      );
    }
  }

  /**
   * Called if task fails or is cancelled.
   */
  async fail(_reason?: string): Promise<void> {
    this.disabled = true;
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = undefined;
    }
    this.pendingText = undefined;
    // Attempt deletion or leave clean state
    try {
      await this.api.deleteMessage(this.options.chatId, this.options.messageId);
    } catch {
      /* ignore */
    }
  }

  private async write(text: string): Promise<void> {
    if (this.disabled || text === this.lastText || text === this.pendingText) return;
    this.pendingText = text;
    const now = Date.now();
    const elapsed = now - this.lastSentAt;
    if (elapsed < MIN_UPDATE_INTERVAL_MS) {
      if (!this.throttleTimer) {
        this.throttleTimer = setTimeout(() => {
          this.throttleTimer = undefined;
          void this.flush();
        }, MIN_UPDATE_INTERVAL_MS - elapsed);
        this.throttleTimer.unref();
      }
      return;
    }
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.disabled || this.pendingText === undefined) return;
    this.flushing = true;
    try {
      while (!this.disabled && this.pendingText !== undefined) {
        const text = this.pendingText;
        this.pendingText = undefined;
        try {
          const timeoutPromise = new Promise<void>((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error('Progress edit timed out')),
              TELEGRAM_REQUEST_TIMEOUT_MS,
            );
            timer.unref();
          });
          await Promise.race([
            this.api.editMessageText(this.options.chatId, this.options.messageId, text),
            timeoutPromise,
          ]);
          this.lastText = text;
          this.lastSentAt = Date.now();
        } catch (error) {
          log.debug(
            { error, messageId: this.options.messageId },
            'task progress edit failed or timed out',
          );
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}
