import { InputFile, type Context } from 'grammy';
import type { Message } from 'grammy/types';
import type { CommandResponse, LocalizedResponse } from '../domain/types.js';
import type { Services } from '../services/index.js';
import { buildInlineKeyboard } from './keyboards.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('render');

/** Schedule best-effort deletion of a message after `ttlMs` (used for ephemeral terms prompts). */
export function scheduleDelete(
  ctx: Context,
  message: { message_id: number } | undefined,
  ttlMs: number,
): void {
  if (!message || !ctx.chat) return;
  const chatId = ctx.chat.id;
  const messageId = message.message_id;
  const timer = setTimeout(() => {
    void ctx.api.deleteMessage(chatId, messageId).catch(() => undefined);
  }, ttlMs);
  timer.unref();
}

/** Localize a CommandResponse into render-ready text using the chat's language. */
export async function localizeResponse(
  services: Services,
  chatId: number,
  response: CommandResponse,
): Promise<LocalizedResponse> {
  const out: LocalizedResponse = {};
  if (response.rawText !== undefined) {
    out.text = response.rawText;
  } else if (response.text !== undefined) {
    const language = await services.getLanguage(chatId);
    const localized = services.localizer.t(response.text, response.vars ?? {}, language);
    out.text = localized ?? response.text;
  }
  if (response.imageUrl !== undefined) out.imageUrl = response.imageUrl;
  if (response.imageBuffer !== undefined) out.imageBuffer = response.imageBuffer;
  if (response.audioBuffer !== undefined) out.audioBuffer = response.audioBuffer;
  if (response.keyboard !== undefined) out.keyboard = response.keyboard;
  return out;
}

/** Send a localized response to Telegram. Priority: audio > image > text. Returns the sent message. */
export async function sendResponse(
  ctx: Context,
  response: LocalizedResponse,
): Promise<Message | undefined> {
  const replyTo = ctx.message?.message_id;
  const reply_markup = response.keyboard ? buildInlineKeyboard(response.keyboard) : undefined;
  const baseOpts = {
    parse_mode: 'HTML' as const,
    ...(replyTo ? { reply_parameters: { message_id: replyTo } } : {}),
  };

  try {
    if (response.audioBuffer) {
      return await ctx.replyWithVoice(new InputFile(response.audioBuffer), {
        ...baseOpts,
        ...(response.text ? { caption: response.text } : {}),
        ...(reply_markup ? { reply_markup } : {}),
      });
    }
    if (response.imageBuffer || response.imageUrl) {
      const photo = response.imageBuffer ? new InputFile(response.imageBuffer) : response.imageUrl!;
      return await ctx.replyWithPhoto(photo, {
        ...baseOpts,
        ...(response.text ? { caption: response.text } : {}),
        ...(reply_markup ? { reply_markup } : {}),
      });
    }
    if (response.text !== undefined && response.text !== '') {
      return await ctx.reply(response.text, {
        ...baseOpts,
        ...(reply_markup ? { reply_markup } : {}),
      });
    }
  } catch (err) {
    log.error({ err }, 'failed to send response');
    // Fallback: try plain text without HTML in case of parse errors.
    if (response.text) {
      try {
        return await ctx.reply(stripHtml(response.text));
      } catch (err2) {
        log.error({ err: err2 }, 'fallback send also failed');
      }
    }
  }
  return undefined;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}
