import { createHash } from 'node:crypto';
import type { Reminder } from './reminders.js';

export interface WorkflowObservation {
  /** Extracted visible content, never executable page instructions. */
  sources: { url: string; title?: string; text: string }[];
}

export interface ObservationSnapshot {
  hash: string;
  sources: { url: string; title?: string; text: string }[];
}

/** Ignore transport and whitespace noise, but never silently ignore a changed source. */
export function snapshotObservation(
  observation: WorkflowObservation,
  expectedUrls: readonly string[],
): ObservationSnapshot {
  if (observation.sources.length !== expectedUrls.length)
    throw new Error('Workflow observation is missing a requested source');
  const expected = new Set(expectedUrls);
  const seen = new Set<string>();
  let bytes = 0;
  const sources = observation.sources.map((source) => {
    if (!expected.has(source.url) || seen.has(source.url))
      throw new Error('Workflow observation source identity does not match');
    seen.add(source.url);
    bytes += Buffer.byteLength(source.text, 'utf8');
    if (bytes > 256 * 1024) throw new Error('Workflow observation exceeds its content budget');
    const text = source.text.normalize('NFC').replace(/\s+/gu, ' ').trim();
    if (!text) throw new Error('Workflow observation has no readable content');
    return { url: source.url, title: source.title?.slice(0, 240), text };
  });
  sources.sort((left, right) => left.url.localeCompare(right.url));
  const hash = createHash('sha256')
    .update(JSON.stringify(sources.map(({ url, text }) => ({ url, text }))))
    .digest('hex');
  return { hash, sources };
}

export function renderWorkflowObservation(
  reminder: Reminder,
  snapshot: ObservationSnapshot,
  observedAt: Date,
): string {
  const heading =
    reminder.kind === 'monitor'
      ? reminder.baselineHash || reminder.lastObservedHash
        ? 'La fonte monitorata è cambiata'
        : 'Prima osservazione della fonte'
      : 'Riepilogo aggiornato';
  const date = new Intl.DateTimeFormat('it', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: reminder.timezone,
  }).format(observedAt);
  const sourceBudget = Math.floor(2300 / Math.max(1, snapshot.sources.length));
  return `${heading}: ${reminder.text.slice(0, 450)}\nOsservato il ${date} (${reminder.timezone}).\n\n${snapshot.sources
    .map(
      (source) =>
        `${source.title || 'Fonte'}\n${source.url}\n${source.text.slice(0, sourceBudget)}${source.text.length > sourceBudget ? '…' : ''}`,
    )
    .join('\n\n')}`.slice(0, 4000);
}

export function localDateKey(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function isQuietAt(
  now: Date,
  timezone: string,
  quietHours: Reminder['quietHours'],
): boolean {
  if (!quietHours) return false;
  const hour = Number(
    new Intl.DateTimeFormat('en', {
      timeZone: timezone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(now),
  );
  return quietHours.startHour < quietHours.endHour
    ? hour >= quietHours.startHour && hour < quietHours.endHour
    : hour >= quietHours.startHour || hour < quietHours.endHour;
}

/** Resolve quiet hours / daily budget in the actual timezone, including DST transitions. */
export function nextAllowedNotificationAt(
  now: Date,
  timezone: string,
  quietHours: Reminder['quietHours'],
  nextDay = false,
): Date {
  const currentDay = localDateKey(now, timezone);
  const start = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;
  for (let time = start; time <= start + 50 * 60 * 60_000; time += 60_000) {
    const candidate = new Date(time);
    if (
      (!nextDay || localDateKey(candidate, timezone) !== currentDay) &&
      !isQuietAt(candidate, timezone, quietHours)
    )
      return candidate;
  }
  throw new Error('No notification window within scheduling horizon');
}
