import type { AnimeArchiveSource } from './types.js';

export interface NaturalAnimeArchiveRequest {
  query: string;
  expectedEpisodeNumber?: string | undefined;
  preferredSource?: AnimeArchiveSource | undefined;
  /** Desire/choice phrasing asks for the normal episode confirmation instead of enqueueing immediately. */
  confirmationPreferred?: boolean | undefined;
}

export interface NaturalAnimeAvailabilityRequest {
  query: string;
  expectedEpisodeNumber?: string | undefined;
  preferredSource?: AnimeArchiveSource | undefined;
}

const REHOST_COMMAND =
  /\b(?:(?:fai|fa|fammi)\s+(?:il\s+)?(?:rehost|download)|rehost(?:a|ami|alo|ala)?|scarica(?:mi|melo|mela|lo|la|te)?|download(?:a|ami|alo|ala)?|(?:puoi|potresti|riesci\s+a)\s+(?:(?:mi|lo|la)\s+)?(?:rehostare|scaricare|downloadare)|(?:voglio|vorrei)\s+(?:(?:vederlo|guardarlo|averlo|scaricarlo|downloadarlo|rehostarlo)|(?:scaricare|downloadare|rehostare)))\b/iu;
const EPISODE_NUMBER = /\b(?:episodio|ep\.?|puntata)\s*#?\s*(\d+(?:[.,]\d+)?)/iu;
const AVAILABILITY_CHECK =
  /\b(?:ricontrolla|controlla|verifica|checka|vedi\s+se|guarda\s+se)\b|\b(?:dovrebbe|dovrebbero)\s+essere\s+arrivat\p{L}*\b/iu;

/**
 * Resolve an explicit natural-language rehost command before the LLM/tool planner.
 *
 * The action must be explicit; the title may come from the command itself or from the factual bot
 * message it quotes. This keeps ordinary anime discussion conversational while making replies such
 * as "rehostami l'episodio 7" deterministic.
 */
export function parseNaturalAnimeArchiveRequest(
  text: string,
  repliedToText?: string,
): NaturalAnimeArchiveRequest | null {
  const normalizedIntent = normalizeForIntent(text);
  const action = REHOST_COMMAND.exec(normalizedIntent);
  if (!action || actionIsNegatedOrInformational(normalizedIntent, action.index)) return null;

  const expectedEpisodeNumber =
    extractEpisodeNumber(text) ?? (repliedToText ? extractEpisodeNumber(repliedToText) : undefined);
  const query =
    extractAnimeTitle(text) ??
    extractCommandTitle(text) ??
    (repliedToText ? extractAnimeTitle(repliedToText) : null);
  if (!query) return null;

  const preferredSource = sourceMention(text);
  const confirmationPreferred = wantsArchiveChoice(normalizedIntent);
  return {
    query,
    ...(expectedEpisodeNumber ? { expectedEpisodeNumber } : {}),
    ...(preferredSource ? { preferredSource } : {}),
    ...(confirmationPreferred ? { confirmationPreferred: true } : {}),
  };
}

/**
 * Resolve an explicit request to re-check whether a named episode is actually available on an
 * archive source. This is a deterministic source lookup, never a conversational/model answer.
 */
export function parseNaturalAnimeAvailabilityRequest(
  text: string,
  repliedToText?: string,
): NaturalAnimeAvailabilityRequest | null {
  const normalized = normalizeForIntent(text);
  if (!AVAILABILITY_CHECK.test(normalized)) return null;

  const expectedEpisodeNumber =
    extractEpisodeNumber(text) ?? (repliedToText ? extractEpisodeNumber(repliedToText) : undefined);
  const query =
    extractAvailabilityTitle(text) ??
    extractAnimeTitle(text) ??
    (repliedToText ? extractAnimeTitle(repliedToText) : null);
  if (!query) return null;

  const preferredSource = sourceMention(text);
  return {
    query,
    ...(expectedEpisodeNumber ? { expectedEpisodeNumber } : {}),
    ...(preferredSource ? { preferredSource } : {}),
  };
}

function actionIsNegatedOrInformational(text: string, actionIndex: number): boolean {
  const prefix = text.slice(Math.max(0, actionIndex - 48), actionIndex);
  // Punctuation starts a new clause: "non so, scaricalo" remains a valid instruction, whereas
  // "non voglio che lo scarichi" and "come faccio a scaricare" are never consent.
  const clause = prefix.split(/[.!?;,]/u).at(-1) ?? prefix;
  return (
    /\b(?:non|mai|evita(?:te)?(?:\s+di)?)\b[^.!?;,]*$/iu.test(clause) ||
    /\b(?:come|dove)\b[^.!?;,]*$/iu.test(clause) ||
    /\b(?:ho|hai|ha|abbiamo|avete|hanno|fatto|finito|gia|il|un)\s*$/iu.test(clause)
  );
}

function extractEpisodeNumber(value: string): string | undefined {
  return EPISODE_NUMBER.exec(normalizeForExtraction(value))?.[1]?.replace(',', '.');
}

function extractAnimeTitle(value: string): string | null {
  const text = normalizeForExtraction(value);
  const patterns = [
    /\bnuovo\s+episodio\s+di\s+(.+?)\s*:\s*(?:episodio|ep\.?|puntata)\s*#?\s*\d/iu,
    /\b(?:episodio|ep\.?|puntata)\s*#?\s*\d+(?:[.,]\d+)?\s+di\s+(.+?)(?=\s+(?:e|è|era|uscit\p{L}*)(?:\s|[.!?\n]|$)|[.!?\n]|$)/iu,
    /^\s*titolo\s*:\s*(.+?)\s*$/imu,
    /^\s*(.+?)\s+[—-]\s*(?:episodio|ep\.?|puntata)\s*#?\s*\d+(?:[.,]\d+)?\s*$/imu,
  ];
  for (const pattern of patterns) {
    const candidate = cleanTitle(pattern.exec(text)?.[1]);
    if (candidate) return candidate;
  }
  return null;
}

function extractAvailabilityTitle(value: string): string | null {
  const text = normalizeForExtraction(value);
  const patterns = [
    /\b(?:ricontrolla|controlla|verifica|checka)(?:\s+(?:un\s+po['’]?|un\s+attimo|per\s+favore|pls))*\s+(.+?)(?=\s*[,;.!?]|\s+(?:dovrebbe|dovrebbero|se|che)\b|$)/iu,
    /\b(?:episodio|ep\.?|puntata)\s*#?\s*\d+(?:[.,]\d+)?\s+di\s+(.+?)(?=\s+(?:su|da)\s+(?:anime\s*unity|hentai\s*saturn)\b|[.!?\n]|$)/iu,
  ];
  for (const pattern of patterns) {
    const candidate = cleanTitle(pattern.exec(text)?.[1]);
    if (candidate) return candidate;
  }
  return null;
}

function extractCommandTitle(value: string): string | null {
  const text = normalizeForExtraction(value);
  const action = REHOST_COMMAND.exec(normalizeForIntent(text));
  if (!action) return null;
  const tail = text
    .slice(action.index + action[0].length)
    .trim()
    .replace(/^[,:;\s-]+/u, '');
  const patterns = [
    /^(?:l[' ]?)?(?:ultim\p{L}*\s+)?(?:episodio|ep\.?|puntata)(?:\s*#?\s*\d+(?:[.,]\d+)?)?\s+di\s+(.+)$/iu,
    /^(.+?)\s+(?:episodio|ep\.?|puntata)\s*#?\s*\d+(?:[.,]\d+)?(?:\s+(?:da|su)\s+(?:anime\s*unity|hentai\s*saturn))?\s*$/iu,
  ];
  for (const pattern of patterns) {
    const candidate = cleanTitle(pattern.exec(tail)?.[1]);
    if (candidate) return candidate;
  }
  if (/^(?:l[' ]?)?(?:ultim\p{L}*\s+)?(?:episodio|ep\.?|puntata)\b/iu.test(tail)) {
    return null;
  }
  const candidate = cleanTitle(tail);
  return candidate && !isGenericArchiveActionTail(candidate) ? candidate : null;
}

function isGenericArchiveActionTail(value: string): boolean {
  const normalized = normalizeForIntent(value);
  return (
    REHOST_COMMAND.test(normalized) ||
    /(?:^|\s)(?:o\s+)?(?:dammi|mandami|passami|girami)\s+(?:il\s+)?link\b/iu.test(normalized) ||
    /^(?:qui|qua|questo|questa|quello|quella|lo|la|lui|lei|subito|adesso)$/iu.test(normalized)
  );
}

function wantsArchiveChoice(value: string): boolean {
  return (
    /\b(?:voglio|vorrei)\b[^.!?]{0,48}\b(?:scaric|download|rehost|guard|veder)/iu.test(value) ||
    /\b(?:rehost|scaric\p{L}*|download\p{L}*)\b[^.!?]{0,48}\bo\s+(?:dammi|mandami|passami|girami)\s+(?:il\s+)?link\b/iu.test(
      value,
    )
  );
}

function cleanTitle(value: string | undefined): string | null {
  if (!value) return null;
  const cleaned = value
    .replace(/https?:\/\/\S+/giu, ' ')
    .replace(/[*_`~]/gu, '')
    .replace(/\s*\([^()]{1,80}\)\s*$/u, '')
    .replace(/(?:^|\s+)(?:da|su)\s+(?:anime\s*unity|hentai\s*saturn)\s*$/iu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^[\s:–—-]+|[\s:–—-]+$/gu, '');
  return cleaned.length >= 2 && cleaned.length <= 180 ? cleaned : null;
}

function sourceMention(value: string): AnimeArchiveSource | undefined {
  const normalized = normalizeForIntent(value);
  if (/\banime\s*unity\b/iu.test(normalized)) return 'animeunity';
  if (/\bhentai\s*saturn\b/iu.test(normalized)) return 'hentaisaturn';
  return undefined;
}

function normalizeForExtraction(value: string): string {
  return value.normalize('NFKC').replace(/[’‘]/gu, "'").trim();
}

function normalizeForIntent(value: string): string {
  return normalizeForExtraction(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('it');
}
