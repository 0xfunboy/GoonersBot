import { InlineKeyboard, type Api } from 'grammy';
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
  messageId?: number;
  threadId?: number;
  language?: string;
  header?: string;
  taskId?: string;
}

function isItalian(lang?: string): boolean {
  return !lang || lang.toLowerCase().startsWith('it');
}

/**
 * In-place progress reporter for companion tasks.
 * Edits the initial acknowledgment message with an advancing progress bar,
 * avoiding spam in the Telegram chat, and finalizes the progress message
 * in-place upon task completion without deleting it to preserve chat replies.
 */
export class CompanionTaskProgressReporter {
  private lastText = '';
  private pendingText: string | undefined;
  private lastSentAt = 0;
  private flushing = false;
  private disabled = false;
  private throttleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly api: Pick<Api, 'editMessageText'>,
    private readonly options: CompanionProgressOptions,
  ) {}

  get messageId(): number | undefined {
    return this.options.messageId;
  }

  setMessageId(messageId: number): void {
    if (Number.isSafeInteger(messageId) && messageId > 0) {
      this.options.messageId = messageId;
      if (this.pendingText !== undefined && !this.flushing) {
        void this.flush();
      }
    }
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
   * Updates the progress message to a clean completed state in-place.
   * Does NOT delete the message, avoiding broken reply links in Telegram.
   */
  async complete(statusText?: string): Promise<void> {
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = undefined;
    }
    const finalStatus =
      statusText || (isItalian(this.options.language) ? '✅ Elaborazione completata!' : '✅ Completed!');
    this.pendingText = finalStatus;
    await this.flush();
    this.disabled = true;
    this.pendingText = undefined;
  }

  /**
   * Called if task fails or is cancelled.
   * Updates the message in-place with a clean failure notice without deletion.
   */
  async fail(reason?: string): Promise<void> {
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = undefined;
    }
    const errorHeader = this.options.header ? `${this.options.header}\n\n` : '';
    const message = reason
      ? `⚠️ ${errorHeader}${reason}`
      : isItalian(this.options.language)
        ? `⚠️ ${errorHeader}Non sono riuscito a completare la richiesta.`
        : `⚠️ ${errorHeader}Could not complete the request.`;
    this.pendingText = message;
    await this.flush();
    this.disabled = true;
    this.pendingText = undefined;
  }

  private async write(text: string): Promise<void> {
    if (this.disabled || text === this.lastText || text === this.pendingText) return;
    this.pendingText = text;
    if (!this.options.messageId) {
      // Waiting for messageId to be attached
      return;
    }
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
    if (this.flushing || this.disabled || this.pendingText === undefined || !this.options.messageId) return;
    this.flushing = true;
    try {
      while (!this.disabled && this.pendingText !== undefined && this.options.messageId) {
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
          const keyboard =
            this.options.taskId && !text.startsWith('✅') && !text.startsWith('⚠️')
              ? new InlineKeyboard()
                  .text('⏹️ Annulla', `task_cancel|${this.options.taskId}`)
                  .text('ℹ️ Dettagli', `task_info|${this.options.taskId}`)
              : undefined;
          const editPromise = keyboard
            ? this.api.editMessageText(this.options.chatId, this.options.messageId, text, {
                reply_markup: keyboard,
              })
            : this.api.editMessageText(this.options.chatId, this.options.messageId, text);
          await Promise.race([editPromise, timeoutPromise]);
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
