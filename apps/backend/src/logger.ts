import pino from 'pino';
import { env } from './env.js';

/** Structured logger for the Loop backend. */
export const logger =
  env.NODE_ENV === 'development'
    ? pino({
        level: env.LOG_LEVEL,
        transport: { target: 'pino-pretty', options: { colorize: true } },
      })
    : pino({ level: env.LOG_LEVEL });
