import { pino, type Logger } from 'pino';
import { getEnv } from '../config/env.js';

let root: Logger | null = null;

export function getLogger(): Logger {
  if (root) return root;
  const env = getEnv();
  const isDev = env.NODE_ENV !== 'production';
  root = pino({
    level: env.LOG_LEVEL,
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
