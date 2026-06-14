import { pino, type Logger } from 'pino';

let root: Logger | null = null;

/**
 * The logger reads LOG_LEVEL / NODE_ENV directly from the environment rather than the validated
 * config, so importing it never triggers full env validation (important for tests and tooling).
 */
export function getLogger(): Logger {
  if (root) return root;
  const level = process.env['LOG_LEVEL'] ?? 'info';
  const isDev = (process.env['NODE_ENV'] ?? 'development') !== 'production';
  root = pino({
    level,
    ...(isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
  return root;
}

export function childLogger(name: string): Logger {
  return getLogger().child({ module: name });
}

export type { Logger };
