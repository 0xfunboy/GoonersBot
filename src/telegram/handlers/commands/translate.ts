import type { CommandResponse } from '../../../domain/types.js';
import type { CommandSpec, HandlerInput } from '../types.js';
import { Priority } from '../types.js';

/** Known language names (Italian + English + native) → canonical English name for the prompt. */
const LANGUAGES: Record<string, string> = {
  italiano: 'Italian',
  italian: 'Italian',
  inglese: 'English',
  english: 'English',
  spagnolo: 'Spanish',
  spanish: 'Spanish',
  espanol: 'Spanish',
  español: 'Spanish',
  francese: 'French',
  french: 'French',
  francais: 'French',
  tedesco: 'German',
  german: 'German',
  deutsch: 'German',
  russo: 'Russian',
  russian: 'Russian',
  portoghese: 'Portuguese',
  portuguese: 'Portuguese',
  cinese: 'Chinese',
  chinese: 'Chinese',
  giapponese: 'Japanese',
  japanese: 'Japanese',
  coreano: 'Korean',
  korean: 'Korean',
  arabo: 'Arabic',
  arabic: 'Arabic',
  olandese: 'Dutch',
  dutch: 'Dutch',
  greco: 'Greek',
  greek: 'Greek',
  turco: 'Turkish',
  turkish: 'Turkish',
  polacco: 'Polish',
  polish: 'Polish',
  rumeno: 'Romanian',
  romanian: 'Romanian',
  latino: 'Latin',
  latin: 'Latin',
};

/**
 * Parse the target language from free-form args. Handles "/traduci spagnolo",
 * "/traduci in spagnolo", "/traduci questo messaggio in spagnolo". Returns a canonical language
 * name when recognized, otherwise the cleaned trailing phrase (the model can still interpret it).
 */
export function parseTargetLanguage(args: string[]): string | null {
  if (args.length === 0) return null;
  const raw = args
    .join(' ')
    .toLowerCase()
    .replace(/[?!.]+$/g, '');
  // Prefer what comes after a connective ("in/to/verso/nel/al/en/into").
  const after = raw.match(/\b(?:in|to|into|verso|nel(?:la)?|al(?:la)?|en)\s+(.+)$/);
  const scope = after?.[1] ?? raw;
  // Recognized language anywhere in the scope, then anywhere in the whole string.
  for (const hay of [scope, raw]) {
    for (const key of Object.keys(LANGUAGES)) {
      if (new RegExp(`(^|\\W)${key}(\\W|$)`).test(hay)) return LANGUAGES[key] as string;
    }
  }
  // Fallback: last word of the scope (covers unlisted languages).
  const last = scope.split(/\s+/).filter(Boolean).pop();
  return last && last.length > 1 ? last : null;
}

/**
 * /translate (alias /traduci) - translate the replied-to message into the requested language.
 * Source language is auto-detected; tone/slang/vulgarity are preserved. Natural phrasing works.
 *   "/translate spanish"  ·  "/traduci in inglese"  ·  "/translate this message into spanish"
 */
export const translateCommand: CommandSpec = {
  command: 'translate',
  aliases: ['traduci'],
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  async handle({ services, context, args }: HandlerInput): Promise<CommandResponse | null> {
    const target = parseTargetLanguage(args);
    if (!target) return { text: 'translate_no_target' };

    // Prefer the replied text straight from Telegram; fall back to stored history.
    let source = context.repliedToText?.trim();
    if (!source && context.repliedToMessageId) {
      const stored = await services.storage.messages.findByMessageId(
        context.chatId,
        context.repliedToMessageId,
      );
      source = stored?.message.messageText?.trim() ?? undefined;
    }
    if (!source) {
      return { text: context.repliedToMessageId ? 'translate_nothing' : 'translate_usage' };
    }

    try {
      const result = await services.llm.chatCompletion({
        system:
          `You are a precise translator. Translate the user's message into ${target}. ` +
          'Auto-detect the source language. Preserve the tone, register, slang and any vulgarity. ' +
          'Output ONLY the translation - no quotes, no notes, no language labels, no preamble.',
        messages: [{ role: 'user', content: source }],
        temperature: 0.2,
      });
      const text = result.text.trim();
      if (!text) return { text: 'translate_failed' };
      return { rawText: text };
    } catch {
      return { text: 'translate_failed' };
    }
  },
};
