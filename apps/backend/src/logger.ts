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
 *
 * Exported so tests can assert against the same list that production uses,
 * rather than keeping a drift-prone copy.
 */
export const REDACT_PATHS: readonly string[] = [
  // Auth headers in any nested shape
  'authorization',
  'Authorization',
  '*.authorization',
  '*.Authorization',
  '*.*.authorization',
  '*.*.Authorization',
  'req.headers.authorization',
  'req.headers.Authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.Authorization',
  'headers.cookie',
  '*.cookie',
  // Token fields in bodies / parsed payloads, any depth up to two levels
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
  // API credentials — cover top-level AND nested, since callers may log
  // either the raw config object or a fetch options object that puts these
  // under `headers` or similar.
  'apiKey',
  'apiSecret',
  '*.apiKey',
  '*.apiSecret',
  '*.*.apiKey',
  '*.*.apiSecret',
  'X-Api-Key',
  'X-Api-Secret',
  '*.X-Api-Key',
  '*.X-Api-Secret',
  // Phase 2 — Stellar wallet material. None of this should ever touch the
  // backend, but defence-in-depth: if a bug ever causes a secret key,
  // mnemonic, or seed phrase to be logged, the value is redacted.
  'secret',
  'privateKey',
  'secretKey',
  'seedPhrase',
  'mnemonic',
  '*.secret',
  '*.privateKey',
  '*.secretKey',
  '*.seedPhrase',
  '*.mnemonic',
  // ADR 016 — operator Stellar secret passed as a typed field on
  // `submitPayout({ secret, ... })` and on the worker tick args.
  // The generic `secret` path above catches the argument field, but
  // env-dumps include the full name — cover both so dumping the env
  // object in a boot log can't leak the key.
  'operatorSecret',
  '*.operatorSecret',
  'LOOP_STELLAR_OPERATOR_SECRET',
  'LOOP_STELLAR_OPERATOR_SECRET_PREVIOUS',
  '*.LOOP_STELLAR_OPERATOR_SECRET',
  '*.LOOP_STELLAR_OPERATOR_SECRET_PREVIOUS',
  // A2-655 + A2-1601 — env-var names for every secret-bearing
  // field loaded into process.env / env.ts. A boot-time
  // `log.debug({ env })` would otherwise leak these verbatim. The
  // generic `secret`/`apiSecret` globs above catch the short field
  // names; these cover the fully-qualified env-key shape.
  //
  //   Loop-native JWT signing keys (ADR 013):
  'LOOP_JWT_SIGNING_KEY',
  'LOOP_JWT_SIGNING_KEY_PREVIOUS',
  '*.LOOP_JWT_SIGNING_KEY',
  '*.LOOP_JWT_SIGNING_KEY_PREVIOUS',
  //   Upstream CTX API credentials:
  'GIFT_CARD_API_KEY',
  'GIFT_CARD_API_SECRET',
  '*.GIFT_CARD_API_KEY',
  '*.GIFT_CARD_API_SECRET',
  //   Transactional email provider API key (ADR 013):
  'RESEND_API_KEY',
  '*.RESEND_API_KEY',
  //   Postgres connection string (includes password):
  'DATABASE_URL',
  '*.DATABASE_URL',
  //   Sentry DSN (public but still flagged by our threat model —
  //   a leaked DSN lets an attacker fill our error quota):
  'SENTRY_DSN',
  '*.SENTRY_DSN',
  //   Discord webhooks — the URLs themselves are the credentials:
  'DISCORD_WEBHOOK_ORDERS',
  'DISCORD_WEBHOOK_MONITORING',
  'DISCORD_WEBHOOK_ADMIN_AUDIT',
  '*.DISCORD_WEBHOOK_ORDERS',
  '*.DISCORD_WEBHOOK_MONITORING',
  '*.DISCORD_WEBHOOK_ADMIN_AUDIT',
  // A4-040: admin-write idempotency keys (ADR-017). They're mint-
  // by-the-handler tokens that key snapshot replay in
  // admin_idempotency_keys; a leaked key plus a stale admin
  // session lets an attacker fake a replay envelope. Both the
  // header shape (`idempotency-key`) and the camelCase body
  // shape (`idempotencyKey`) are logged by handlers — redact at
  // every nesting depth pino's path syntax can express. Pair with
  // the Sentry scrubber regex (sentry-scrubber.ts SENSITIVE_KEY_RE,
  // A4-039) so neither pipe leaks.
  'idempotencyKey',
  '*.idempotencyKey',
  '*.*.idempotencyKey',
  'idempotency-key',
  '*.idempotency-key',
  '*.*.idempotency-key',
  'Idempotency-Key',
  '*.Idempotency-Key',
  '*.*.Idempotency-Key',
];

const basePinoOptions = {
  level: env.LOG_LEVEL,
  base: { service: 'loop-backend', env: env.NODE_ENV },
  redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
};

/** Structured logger for the Loop backend. */
export const logger =
  env.NODE_ENV === 'development'
    ? pino({
        ...basePinoOptions,
        transport: { target: 'pino-pretty', options: { colorize: true } },
      })
    : pino(basePinoOptions);
