const TIME_ZONE = 'Europe/Rome';
const HOURLY_REASONS = new Set(['conversation_hourly', 'passive_hourly']);
const DAILY_REASONS = new Set([
  'conversation_daily',
  'llm_tokens',
  'web_search',
  'page_scan',
  'news',
  'image',
  'media',
  'media_bytes',
]);

interface QuotaRetry {
  reason?: string;
  retryAfterSeconds?: number;
}

export function formatQuotaRetry(decision: QuotaRetry, language: string, now = new Date()): string {
  const seconds = Math.max(1, Math.ceil(decision.retryAfterSeconds ?? 0));
  if (!decision.retryAfterSeconds) return phrase(language, 'next_reset');
  const resetAt = new Date(now.getTime() + seconds * 1_000);
  const resetTime = new Intl.DateTimeFormat(localeFor(language), {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(resetAt);

  if (decision.reason && DAILY_REASONS.has(decision.reason)) {
    return phrase(language, 'daily', resetTime);
  }
  if (decision.reason && HOURLY_REASONS.has(decision.reason)) {
    return phrase(language, 'hourly', String(Math.max(1, Math.ceil(seconds / 60))), resetTime);
  }
  if (seconds >= 60) {
    return phrase(language, 'minutes', String(Math.max(1, Math.ceil(seconds / 60))));
  }
  return phrase(language, 'seconds', String(seconds));
}

function localeFor(language: string): string {
  if (language === 'italian') return 'it-IT';
  if (language === 'russian') return 'ru-RU';
  if (language === 'spanish') return 'es-ES';
  return 'en-GB';
}

function phrase(language: string, kind: string, value = '', time = ''): string {
  const phrases: Record<string, Record<string, string>> = {
    italian: {
      next_reset: 'al prossimo reset',
      daily: `al reset giornaliero delle ${value}`,
      hourly: `tra ${value} min (reset alle ${time})`,
      minutes: `tra ${value} min`,
      seconds: `tra ${value}s`,
    },
    english: {
      next_reset: 'after the next reset',
      daily: `after the daily reset at ${value}`,
      hourly: `in ${value} min (reset at ${time})`,
      minutes: `in ${value} min`,
      seconds: `in ${value}s`,
    },
    russian: {
      next_reset: 'после следующего сброса',
      daily: `после ежедневного сброса в ${value}`,
      hourly: `через ${value} мин (сброс в ${time})`,
      minutes: `через ${value} мин`,
      seconds: `через ${value} с`,
    },
    spanish: {
      next_reset: 'tras el próximo reinicio',
      daily: `tras el reinicio diario de las ${value}`,
      hourly: `en ${value} min (reinicio a las ${time})`,
      minutes: `en ${value} min`,
      seconds: `en ${value}s`,
    },
  };
  return (phrases[language] ?? phrases['english'])?.[kind] ?? 'after the next reset';
}
