import pino from 'pino';
import { env } from './env.js';

/**
 * Pino redaction paths — fields whose values must never appear in logs even
 * when callers blindly log a whole request/response/error. Keep this list
 * conservative: redacting too much hides debugging context, redacting too
 * little leaks credentials.
 *
 * We deliberately do NOT redact `email` — operators need to know which user
 * an auth failure applied to. OTP codes and all token variants ARE redacted.
 */
const REDACT_PATHS = [
  // Auth headers in any nested shape
  'authorization',
  'Authorization',
  '*.authorization',
  '*.Authorization',
  'req.headers.authorization',
  'req.headers.Authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.Authorization',
  'headers.cookie',
  // Token fields in bodies / parsed payloads
  'accessToken',
  'refreshToken',
  '*.accessToken',
  '*.refreshToken',
  '*.*.accessToken',
  '*.*.refreshToken',
  // Short-lived credentials
  'otp',
  'code',
  '*.otp',
  'password',
  '*.password',
  // API credentials
  '*.apiKey',
  '*.apiSecret',
  '*.X-Api-Key',
  '*.X-Api-Secret',
];

/** Structured logger for the Loop backend. */
export const logger =
  env.NODE_ENV === 'development'
    ? pino({
        level: env.LOG_LEVEL,
        base: { service: 'loop-backend', env: env.NODE_ENV },
        redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
        transport: { target: 'pino-pretty', options: { colorize: true } },
      })
    : pino({
        level: env.LOG_LEVEL,
        base: { service: 'loop-backend', env: env.NODE_ENV },
        redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      });
