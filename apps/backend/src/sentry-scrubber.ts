/**
 * Sentry PII scrubber (A2-1308).
 *
 * Sentry's default `sendDefaultPii: false` omits the request body, user
 * IP, and query string — but it does NOT scrub header names it doesn't
 * recognise, nested custom `extra` keys, or env-shaped secret bearers
 * that might end up in an error message or breadcrumb. Loop's threat
 * model demands that signing keys, upstream CTX credentials, Postgres
 * connection strings, Sentry DSNs, and Discord webhook URLs never
 * reach telemetry.
 *
 * `scrubSentryEvent` walks the event shape, replacing any string value
 * at a known-secret key with `[REDACTED]`. Mirrors the backend logger's
 * REDACT_PATHS but applied post-hoc (Sentry events are already
 * structured JSON by the time they reach `beforeSend`).
 *
 * Keep this list in sync with logger.ts REDACT_PATHS. Any secret added
 * there must also land here — Sentry bypasses the logger.
 */

/**
 * Field names whose value must be redacted anywhere in the event.
 *
 * A4-039: idempotency keys are admin-write identifiers that must
 * not land in Sentry breadcrumbs. The web UI mints them via
 * `crypto.randomUUID()` and the backend keys snapshot replay on
 * `(adminUserId, key)`; an attacker with leaked keys + an admin
 * session can replay a stored response or fabricate an
 * `audit.replayed: true` envelope. Match both the camelCase shape
 * (`idempotencyKey`) used in handler bodies and the header shape
 * (`idempotency-key` / `Idempotency-Key`).
 */
const SENSITIVE_KEY_RE =
  /^(authorization|cookie|accesstoken|refreshtoken|otp|password|apikey|apisecret|secret|privatekey|secretkey|seedphrase|mnemonic|operatorsecret|loop_jwt_signing_key(_previous)?|gift_card_api_(key|secret)|database_url|sentry_dsn|discord_webhook_(orders|monitoring|admin_audit)|idempotencykey|idempotency-key)$/i;

/** Minimal subset of the Sentry event shape that we read. */
export interface SentryEventLike {
  request?: {
    headers?: Record<string, unknown>;
    data?: unknown;
    cookies?: Record<string, unknown>;
  };
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  tags?: Record<string, unknown>;
}

/**
 * Returns a new event with known-secret values replaced by
 * `[REDACTED]`. Safe on arbitrary shapes — any non-string value at a
 * sensitive key is left untouched (preserves primitives other than
 * strings; nested objects are recursed). Never throws; on an
 * unexpected shape the event passes through unchanged rather than
 * dropping the error.
 */
export function scrubSentryEvent<T extends SentryEventLike>(event: T): T {
  try {
    const scrubbed = { ...event };
    if (event.request !== undefined) {
      scrubbed.request = {
        ...event.request,
        ...(event.request.headers !== undefined
          ? { headers: scrubObject(event.request.headers) }
          : {}),
        ...(event.request.data !== undefined ? { data: scrubAny(event.request.data) } : {}),
        ...(event.request.cookies !== undefined
          ? { cookies: scrubObject(event.request.cookies) }
          : {}),
      };
    }
    if (event.extra !== undefined) scrubbed.extra = scrubObject(event.extra);
    if (event.contexts !== undefined) scrubbed.contexts = scrubObject(event.contexts);
    if (event.tags !== undefined) scrubbed.tags = scrubObject(event.tags);
    return scrubbed;
  } catch {
    return event;
  }
}

/**
 * Recursively walks `v`. At every object key matching
 * SENSITIVE_KEY_RE, replaces the string value with `[REDACTED]`.
 * Non-string values at sensitive keys are left as-is — the
 * assumption is that a secret must be a string to be useful.
 */
function scrubObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEY_RE.test(key) && typeof value === 'string') {
      out[key] = '[REDACTED]';
    } else {
      out[key] = scrubAny(value);
    }
  }
  return out;
}

function scrubAny(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(scrubAny);
  if (typeof value === 'object') return scrubObject(value as Record<string, unknown>);
  return value;
}
