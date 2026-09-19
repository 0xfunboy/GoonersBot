import { createHash } from 'node:crypto';
import type { ToolExecutionOutput } from '../../agent/types.js';
import type { TaskScope } from '../tasks/contracts.js';
import {
  nextWeeklyAt,
  type Reminder,
  type ReminderService,
  type CreateReminderInput,
} from './reminders.js';

/** The service receives actor and destination exclusively from the host, never from model args. */
export async function executeReminderOperation(input: {
  service: ReminderService;
  args: Record<string, unknown>;
  scope: TaskScope;
  requestKey?: string;
  operationId: string;
  allowWrite: boolean;
  language: string;
  signal: AbortSignal;
}): Promise<ToolExecutionOutput> {
  input.signal.throwIfAborted();
  const string = (key: string): string | undefined =>
    typeof input.args[key] === 'string' && (input.args[key] as string).trim()
      ? (input.args[key] as string).trim()
      : undefined;
  const number = (key: string): number | undefined => {
    const raw = input.args[key];
    if (raw === undefined || raw === null || raw === '') return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`Invalid reminder ${key}`);
    return value;
  };
  const intent = string('intent');
  const kind = string('kind');
  if (kind && !['reminder', 'monitor', 'report'].includes(kind))
    throw new Error('Unsupported workflow kind');
  const intervalMinutes =
    number('intervalMinutes') ??
    (intent === 'create' && kind === 'monitor' && !string('weekdays') ? 30 : undefined);
  const sourcesArg = input.args['sourceUrls'];
  let sourceUrls: string[] | undefined;
  if (Array.isArray(sourcesArg)) {
    if (!sourcesArg.every((url): url is string => typeof url === 'string'))
      throw new Error('Workflow sources must be URLs');
    sourceUrls = sourcesArg.map((url) => url.trim());
  } else if (typeof sourcesArg === 'string' && sourcesArg.trim()) {
    if (sourcesArg.trim().startsWith('[')) {
      const decoded: unknown = JSON.parse(sourcesArg);
      if (
        !Array.isArray(decoded) ||
        !decoded.every((url): url is string => typeof url === 'string')
      )
        throw new Error('Workflow sources must be URLs');
      sourceUrls = decoded.map((url) => url.trim());
    } else
      sourceUrls = sourcesArg
        .split(/[\n,]/u)
        .map((url) => url.trim())
        .filter(Boolean);
  }
  const firstObservation = input.args['notifyOnFirstObservation'];
  if (
    firstObservation !== undefined &&
    ![true, false, 'true', 'false'].includes(firstObservation as string | boolean)
  )
    throw new Error('Invalid first-observation notification flag');
  const notifyOnFirstObservation =
    firstObservation === undefined
      ? undefined
      : firstObservation === true || firstObservation === 'true';
  const quietStartHour = number('quietStartHour');
  const quietEndHour = number('quietEndHour');
  if ((quietStartHour === undefined) !== (quietEndHour === undefined))
    throw new Error('Quiet hours require both start and end');
  const quietHours =
    quietStartHour !== undefined && quietEndHour !== undefined
      ? { startHour: quietStartHour, endHour: quietEndHour }
      : undefined;
  const text = (message: string): ToolExecutionOutput => ({
    summary: message,
    data: { kind: 'text', text: message },
    verified: true,
  });
  if (intent !== 'list' && !input.allowWrite)
    throw new Error('Reminder changes require host authorization for this conversation');
  if (intent === 'list') {
    const reminders = await input.service.list(input.scope);
    return text(
      reminders.length
        ? reminders.map((reminder) => reminderLabel(reminder, input.language)).join('\n')
        : 'Non hai promemoria o monitoraggi attivi in questa conversazione.',
    );
  }
  const active = intent === 'create' ? [] : await input.service.list(input.scope);
  const id = string('id');
  const match = string('match')?.toLocaleLowerCase();
  const matches = active.filter((reminder) =>
    kind && (reminder.kind ?? 'reminder') !== kind
      ? false
      : id
        ? reminder.id === id
        : match
          ? `${reminder.text} ${reminder.sourceUrls?.join(' ') ?? ''}`
              .toLocaleLowerCase()
              .includes(match)
          : true,
  );
  const target = matches.length === 1 ? matches[0] : undefined;
  if (intent !== 'create' && !target) {
    return text(
      matches.length > 1
        ? `Quale promemoria intendi? ${matches
            .slice(0, 5)
            .map((reminder) => reminder.text.slice(0, 100))
            .join(' · ')}`
        : 'Non trovo quel promemoria tra quelli attivi in questa conversazione.',
    );
  }
  if (intent === 'cancel' && target) {
    const cancelled = await input.service.cancel({
      id: target.id,
      scope: input.scope,
      expectedVersion: target.version,
    });
    return text(
      cancelled
        ? `Promemoria annullato: ${target.text}`
        : 'Il promemoria è cambiato mentre lo aggiornavo; controlla il suo stato prima di riprovare.',
    );
  }
  if (intent !== 'create' && intent !== 'update') throw new Error('Unsupported reminder operation');
  const delay = number('delayMinutes');
  if (delay !== undefined && (delay <= 0 || delay > 525600))
    throw new Error('Reminder delay must be within one year');
  const timezone =
    string('timezone') ??
    target?.timezone ??
    ((delay !== undefined || intervalMinutes !== undefined) && !quietHours ? 'UTC' : undefined);
  if (!timezone) return text('Quale fuso orario devo usare per questo promemoria?');
  const weekly: CreateReminderInput['weeklyWallTime'] = string('weekdays')
    ? {
        weekdays: string('weekdays')!
          .split(',')
          .map((day) => Number(day.trim())),
        hour: number('hour') ?? -1,
        minute: number('minute') ?? 0,
      }
    : undefined;
  if (
    weekly &&
    (!weekly.weekdays.length ||
      weekly.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
      !Number.isInteger(weekly.hour) ||
      weekly.hour < 0 ||
      weekly.hour > 23 ||
      !Number.isInteger(weekly.minute) ||
      weekly.minute < 0 ||
      weekly.minute > 59)
  ) {
    throw new Error('Invalid weekly reminder schedule');
  }
  const runAt =
    delay !== undefined
      ? new Date(Date.now() + delay * 60_000).toISOString()
      : (string('runAt') ??
        (weekly
          ? nextWeeklyAt(new Date(), timezone, weekly).toISOString()
          : kind === 'monitor'
            ? new Date().toISOString()
            : intervalMinutes !== undefined
              ? new Date(Date.now() + intervalMinutes * 60_000).toISOString()
              : undefined));
  if (!runAt && intent === 'create') return text('Per quando devo impostare il promemoria?');
  const message = string('text');
  if (!message && intent === 'create')
    return text(
      kind === 'reminder' || !kind
        ? 'Che cosa devo ricordarti?'
        : 'Che cosa devo monitorare o includere nel riepilogo?',
    );
  if (intent === 'create' && (kind === 'monitor' || kind === 'report') && !sourceUrls?.length)
    return text('Quali pagine devo usare come fonti? Mandami i link da osservare.');
  input.signal.throwIfAborted();
  let reminder: Reminder | null;
  if (intent === 'create') {
    if (!input.requestKey)
      throw new Error('Missing durable request identity for reminder creation');
    const key = `reminder:${createHash('sha256').update(`${input.requestKey}:${input.operationId}`).digest('hex')}`;
    reminder = await input.service.create({
      key,
      scope: input.scope,
      text: message!,
      runAt: runAt!,
      timezone,
      intervalMinutes,
      weeklyWallTime: weekly,
      expiresAt: string('expiresAt'),
      maxOccurrences: number('maxOccurrences'),
      kind: kind as CreateReminderInput['kind'],
      sourceUrls,
      quietHours,
      maxChecks: number('maxChecks'),
      maxNotificationsPerDay: number('maxNotificationsPerDay'),
      notifyOnFirstObservation,
    });
  } else {
    if (
      !message &&
      !runAt &&
      !string('timezone') &&
      number('intervalMinutes') === undefined &&
      !weekly &&
      !sourceUrls &&
      !quietHours &&
      !string('expiresAt') &&
      number('maxChecks') === undefined &&
      number('maxOccurrences') === undefined &&
      number('maxNotificationsPerDay') === undefined &&
      notifyOnFirstObservation === undefined
    ) {
      return text('Che cosa vuoi cambiare del promemoria?');
    }
    reminder = await input.service.update({
      id: target!.id,
      scope: input.scope,
      expectedVersion: target!.version,
      text: message,
      runAt,
      timezone,
      intervalMinutes: weekly ? null : intervalMinutes,
      weeklyWallTime: intervalMinutes !== undefined ? null : weekly,
      expiresAt: string('expiresAt'),
      sourceUrls,
      quietHours,
      maxChecks: number('maxChecks'),
      maxOccurrences: number('maxOccurrences'),
      maxNotificationsPerDay: number('maxNotificationsPerDay'),
      notifyOnFirstObservation,
    });
  }
  if (!reminder)
    return text(
      'Il promemoria è cambiato mentre lo aggiornavo; controlla il suo stato prima di riprovare.',
    );
  return {
    summary: `${reminder.kind === 'monitor' ? 'Monitoraggio' : reminder.kind === 'report' ? 'Riepilogo programmato' : 'Promemoria'} ${intent === 'create' ? 'impostato' : 'aggiornato'}: ${reminderLabel(reminder, input.language)}`,
    data: {
      kind: 'workflow',
      receiptId: reminder.id,
      version: reminder.version,
      status: reminder.status,
      nextRunAt: reminder.nextRunAt.toISOString(),
      timezone: reminder.timezone,
      text: reminder.text,
      workflowKind: reminder.kind ?? 'reminder',
      sourceUrls: reminder.sourceUrls,
      expiresAt: reminder.expiresAt?.toISOString(),
    },
    verified: true,
  };
}

function reminderLabel(reminder: Reminder, language: string): string {
  const locale = /^en|english/i.test(language) ? 'en' : /^es|spanish/i.test(language) ? 'es' : 'it';
  const date = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: reminder.timezone,
  }).format(reminder.nextRunAt);
  const cadence = reminder.weeklyWallTime
    ? ' · ricorrente settimanale'
    : reminder.intervalMinutes
      ? ` · ogni ${reminder.intervalMinutes} minuti`
      : '';
  const kind =
    reminder.kind === 'monitor'
      ? '[monitoraggio] '
      : reminder.kind === 'report'
        ? '[riepilogo] '
        : '';
  const expiry = reminder.expiresAt
    ? ` · fino al ${new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeZone: reminder.timezone }).format(reminder.expiresAt)}`
    : '';
  const uncertain =
    reminder.status === 'delivery_unknown'
      ? ' · invio dall’esito incerto, sospeso per evitare duplicati'
      : reminder.status === 'paused'
        ? ' · sospeso: le fonti non sono leggibili; puoi correggere il link o riprogrammarlo'
        : '';
  return `${kind}${reminder.text} — ${date} (${reminder.timezone})${cadence}${expiry}${uncertain}`;
}
