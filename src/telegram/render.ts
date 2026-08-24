import { InputFile, type Context } from 'grammy';
import type { Message } from 'grammy/types';
import type { CommandResponse, LocalizedResponse } from '../domain/types.js';
import type { Services } from '../services/index.js';
import { buildInlineKeyboard } from './keyboards.js';
import { childLogger } from '../utils/logger.js';
import {
  renderTelegramText,
  splitTelegramMarkdown,
  splitTelegramText,
  telegramPlainText,
} from './format.js';
import { formatQuotaRetry } from './quotaMessage.js';

const log = childLogger('render');

export function isTelegramReplyTargetMissingError(error: unknown): boolean {
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null
        ? JSON.stringify(error)
        : String(error);
  return /message to be replied not found|reply message not found/i.test(detail);
}

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
    out.textFormat = response.textFormat ?? 'markdown';
  } else if (response.text !== undefined) {
    const language = await services.getLanguage(chatId);
    let vars = response.vars ?? {};
    if (response.text === 'group_quota_exceeded' && vars['retry_when'] === undefined) {
      const reason = typeof vars['reason'] === 'string' ? vars['reason'] : undefined;
      const rawRetry = vars['retry_after'];
      const retryAfterSeconds = typeof rawRetry === 'number' && rawRetry > 0 ? rawRetry : undefined;
      vars = {
        ...vars,
        retry_when: formatQuotaRetry({ reason, retryAfterSeconds }, language),
      };
    }
    const localized = services.localizer.t(response.text, vars, language);
    out.text = localized ?? response.text;
    out.textFormat = response.textFormat ?? 'html';
  }
  if (response.imageUrl !== undefined) out.imageUrl = response.imageUrl;
  if (response.imageBuffer !== undefined) out.imageBuffer = response.imageBuffer;
  if (response.imageSpoiler !== undefined) out.imageSpoiler = response.imageSpoiler;
  if (response.audioBuffer !== undefined) out.audioBuffer = response.audioBuffer;
  if (response.videoBuffer !== undefined) out.videoBuffer = response.videoBuffer;
  if (response.videoSpoiler !== undefined) out.videoSpoiler = response.videoSpoiler;
  if (response.videoMeta !== undefined) out.videoMeta = response.videoMeta;
  if (response.keyboard !== undefined) out.keyboard = response.keyboard;
  return out;
}

/** Send a localized response to Telegram. Priority: audio > image > text. Returns the sent message. */
export async function sendResponse(
  ctx: Context,
  response: LocalizedResponse,
): Promise<Message | undefined> {
  const replyTo = ctx.message?.message_id;
  const reply_markup = response.keyboard
    ? buildInlineKeyboard(response.keyboard, response.keyboard.page ?? 0)
    : undefined;
  const textFormat = response.textFormat ?? 'html';
  const rendered = response.text ? renderTelegramText(response.text, textFormat) : undefined;
  const plainText = response.text ? telegramPlainText(response.text, textFormat) : undefined;
  const captionRendered = plainText && plainText.length <= 1_000 ? rendered : undefined;
  const replyOpts = {
    ...(replyTo ? { reply_parameters: { message_id: replyTo } } : {}),
  };
  const formattedOpts = {
    ...replyOpts,
    ...(rendered ? { parse_mode: rendered.parseMode } : {}),
  };

  const sendOverflowText = async (): Promise<void> => {
    if (!rendered || captionRendered) return;
    if ((plainText?.length ?? 0) <= 3_900) {
      await ctx
        .reply(rendered.text, formattedOpts)
        .catch(() => ctx.reply(plainText ?? response.text ?? '', replyOpts));
      return;
    }
    for (const chunk of splitTelegramText(plainText ?? response.text ?? '')) {
      await ctx.reply(chunk, replyOpts);
    }
  };

  try {
    if (response.audioBuffer) {
      const sendVoice = (formatted: boolean) =>
        ctx.replyWithVoice(new InputFile(response.audioBuffer!), {
          ...replyOpts,
          ...(formatted && captionRendered ? { parse_mode: captionRendered.parseMode } : {}),
          ...(captionRendered
            ? { caption: formatted ? captionRendered.text : (plainText ?? '') }
            : {}),
          ...(reply_markup ? { reply_markup } : {}),
        });
      const sent = await sendMediaWithCaptionFallback(sendVoice, Boolean(captionRendered));
      await sendOverflowText();
      return sent;
    }
    if (response.videoBuffer) {
      // supports_streaming + dimensions + poster => inline autoplaying player instead of a file.
      const meta = response.videoMeta ?? {};
      const sendVideo = (formatted: boolean) =>
        ctx.replyWithVideo(new InputFile(response.videoBuffer!), {
          ...replyOpts,
          ...(formatted && captionRendered ? { parse_mode: captionRendered.parseMode } : {}),
          supports_streaming: true,
          ...(captionRendered
            ? { caption: formatted ? captionRendered.text : (plainText ?? '') }
            : {}),
          ...(response.videoSpoiler ? { has_spoiler: true } : {}),
          ...(typeof meta.width === 'number' ? { width: meta.width } : {}),
          ...(typeof meta.height === 'number' ? { height: meta.height } : {}),
          ...(typeof meta.duration === 'number' ? { duration: meta.duration } : {}),
          ...(meta.thumbnail ? { thumbnail: new InputFile(meta.thumbnail) } : {}),
          ...(reply_markup ? { reply_markup } : {}),
        });
      const sent = await sendMediaWithCaptionFallback(sendVideo, Boolean(captionRendered));
      await sendOverflowText();
      return sent;
    }
    if (response.imageBuffer || response.imageUrl) {
      const sendPhoto = (formatted: boolean) =>
        ctx.replyWithPhoto(
          response.imageBuffer ? new InputFile(response.imageBuffer) : response.imageUrl!,
          {
            ...replyOpts,
            ...(formatted && captionRendered ? { parse_mode: captionRendered.parseMode } : {}),
            ...(captionRendered
              ? { caption: formatted ? captionRendered.text : (plainText ?? '') }
              : {}),
            ...(response.imageSpoiler ? { has_spoiler: true } : {}),
            ...(reply_markup ? { reply_markup } : {}),
          },
        );
      const sent = await sendMediaWithCaptionFallback(sendPhoto, Boolean(captionRendered));
      await sendOverflowText();
      return sent;
    }
    if (rendered && rendered.text !== '') {
      if ((plainText?.length ?? 0) > 3_900) {
        const sourceChunks =
          textFormat === 'markdown'
            ? splitTelegramMarkdown(response.text ?? '')
            : splitTelegramText(textFormat === 'html' ? (plainText ?? '') : (response.text ?? ''));
        let first: Message | undefined;
        for (const [index, sourceChunk] of sourceChunks.entries()) {
          const chunkFormat = textFormat === 'html' ? 'plain' : textFormat;
          const chunk = renderTelegramText(sourceChunk, chunkFormat);
          const options = {
            ...(index === 0 ? replyOpts : {}),
            parse_mode: chunk.parseMode,
            ...(index === 0 && reply_markup ? { reply_markup } : {}),
          };
          const sent = await ctx
            .reply(chunk.text, options)
            .catch(() => ctx.reply(telegramPlainText(sourceChunk, chunkFormat)));
          first ??= sent;
        }
        return first;
      }
      return await ctx.reply(rendered.text, {
        ...formattedOpts,
        ...(reply_markup ? { reply_markup } : {}),
      });
    }
  } catch (err) {
    log.error({ err }, 'failed to send response');
    if (response.text) {
      try {
        // Telegram can delete the triggering message while generation is in flight. The prepared
        // response is still valid; retry it as a normal chat message instead of converting a stale
        // reply target into a fake generation failure.
        if (isTelegramReplyTargetMissingError(err)) {
          log.warn('reply target disappeared; retrying response without reply_parameters');
          return await ctx.reply(telegramPlainText(response.text, textFormat), {
            ...(reply_markup ? { reply_markup } : {}),
          });
        }
        // Fallback: try plain text without HTML in case of parse errors.
        return await ctx.reply(telegramPlainText(response.text, textFormat), {
          ...replyOpts,
          ...(reply_markup ? { reply_markup } : {}),
        });
      } catch (err2) {
        log.error({ err: err2 }, 'fallback send also failed');
      }
    }
  }
  return undefined;
}

async function sendMediaWithCaptionFallback(
  send: (formatted: boolean) => Promise<Message>,
  hasFormattedCaption: boolean,
): Promise<Message> {
  try {
    return await send(hasFormattedCaption);
  } catch (err) {
    if (!hasFormattedCaption || !isTelegramEntityParseError(err)) throw err;
    log.warn({ err }, 'formatted media caption rejected; retrying same media as plain text');
    return send(false);
  }
}

function isTelegramEntityParseError(error: unknown): boolean {
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null
        ? JSON.stringify(error)
        : String(error);
  return /parse entities|unsupported start tag|can't find end tag|wrong entity/i.test(detail);
}
