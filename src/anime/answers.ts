import type { AnimeSeries, AnimeStatus, IsoWeekday } from './types.js';

/**
 * Deterministic rendering of catalog facts.
 *
 * The agent composer decides tone and wording; these helpers decide *what is true*. Keeping the
 * two apart is what stops a confident-sounding model from inventing an episode number.
 */

const STATUS_LABEL: Readonly<Record<AnimeStatus, string>> = {
  ongoing: 'in corso',
  finished: 'concluso',
  not_yet_released: 'non ancora uscito',
  cancelled: 'cancellato',
  hiatus: 'in pausa',
  unknown: 'stato non pubblicato dalla fonte',
};

const WEEKDAY_LABEL: Readonly<Record<IsoWeekday, string>> = {
  1: 'lunedì',
  2: 'martedì',
  3: 'mercoledì',
  4: 'giovedì',
  5: 'venerdì',
  6: 'sabato',
  7: 'domenica',
};

export function statusLabel(status: AnimeStatus): string {
  return STATUS_LABEL[status];
}

export function weekdayLabel(weekday: IsoWeekday | undefined): string | undefined {
  return weekday === undefined ? undefined : WEEKDAY_LABEL[weekday];
}

/** ISO date (UTC) - unambiguous for a bot serving several locales in the same chat. */
export function isoDate(date: Date | undefined): string | undefined {
  if (!date || !Number.isFinite(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

/**
 * Compact factual summary of one series, one fact per line.
 *
 * Every line is omitted when the underlying field is unknown, so the model is never handed a
 * "sconosciuto" placeholder it might smooth over into a plausible-sounding number.
 */
export function describeSeries(series: AnimeSeries): string {
  const lines: string[] = [`Titolo: ${series.title}`];

  const otherTitles = [series.titleRomaji, series.titleNative]
    .filter((title): title is string => Boolean(title) && title !== series.title)
    .slice(0, 2);
  if (otherTitles.length > 0) lines.push(`Titoli alternativi: ${otherTitles.join(' / ')}`);

  lines.push(`Stato: ${statusLabel(series.status)}`);

  if (series.latestEpisode !== undefined) {
    lines.push(
      series.episodeCount !== undefined
        ? `Ultimo episodio uscito: ${series.latestEpisode} su ${series.episodeCount}`
        : `Ultimo episodio uscito: ${series.latestEpisode}`,
    );
  } else if (series.episodeCount !== undefined) {
    lines.push(`Episodi totali previsti: ${series.episodeCount}`);
  }

  if (series.nextEpisode) {
    const when = isoDate(series.nextEpisode.airingAt);
    lines.push(
      `Prossimo episodio: ${series.nextEpisode.episode}${when ? ` il ${when} (UTC)` : ''}`,
    );
  }

  const weekday = weekdayLabel(series.airingWeekday);
  if (weekday) lines.push(`Giorno di uscita abituale: ${weekday}`);

  if (series.season && series.seasonYear) {
    lines.push(`Stagione: ${series.season} ${series.seasonYear}`);
  } else if (series.seasonYear) {
    lines.push(`Anno: ${series.seasonYear}`);
  }

  if (series.genres.length > 0) lines.push(`Generi: ${series.genres.slice(0, 6).join(', ')}`);
  if (series.studios.length > 0) lines.push(`Studio: ${series.studios.slice(0, 3).join(', ')}`);
  if (series.score !== undefined) lines.push(`Punteggio community: ${series.score}/100`);

  lines.push(`Scheda: ${series.url}`);

  if (series.streamingLinks.length > 0) {
    const where = series.streamingLinks
      .slice(0, 4)
      .map((link) => `${link.site}: ${link.url}`)
      .join(' | ');
    lines.push(`Dove vederlo legalmente: ${where}`);
  }

  return lines.join('\n');
}

/** One-line form used in ranked candidate lists and follow listings. */
export function summarizeSeries(series: AnimeSeries): string {
  const total = series.episodeCount !== undefined ? `/${series.episodeCount}` : '';
  const detail =
    series.latestEpisode !== undefined
      ? `${statusLabel(series.status)}, ep. ${series.latestEpisode}${total}`
      : statusLabel(series.status);
  return `${series.title} (${detail}) - ${series.url}`;
}

/**
 * Answer for "è uscito l'ultimo episodio di X?".
 *
 * Deliberately states the unknown case as unknown: for a currently-airing show with no scheduled
 * next episode the honest answer is that the source has not published one.
 */
export function describeLatestRelease(series: AnimeSeries): string {
  const header = describeSeries(series);
  if (series.status === 'not_yet_released') {
    const when = isoDate(series.nextEpisode?.airingAt);
    return `${header}\n\nVerdetto: non è ancora uscito nulla${when ? `; il primo episodio è previsto per il ${when} (UTC)` : ''}.`;
  }
  if (series.status === 'finished') {
    return `${header}\n\nVerdetto: la serie è conclusa, sono usciti tutti gli episodi disponibili.`;
  }
  if (series.latestEpisode === undefined) {
    return `${header}\n\nVerdetto: la fonte non pubblica un numero di episodio aggiornato per questa serie.`;
  }
  if (series.nextEpisode) {
    const when = isoDate(series.nextEpisode.airingAt);
    return `${header}\n\nVerdetto: l'ultimo episodio uscito è il ${series.latestEpisode}; il ${series.nextEpisode.episode} esce${when ? ` il ${when} (UTC)` : ' prossimamente'}.`;
  }
  return `${header}\n\nVerdetto: l'ultimo episodio uscito è il ${series.latestEpisode}.`;
}

/** Ranked shortlist shown instead of guessing when a title stays ambiguous. */
export function describeCandidates(candidates: readonly AnimeSeries[]): string {
  return candidates.map((series, index) => `${index + 1}. ${summarizeSeries(series)}`).join('\n');
}
