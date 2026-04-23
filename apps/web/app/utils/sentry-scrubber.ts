/**
 * Sentry PII scrubber (A2-1308) — web side.
 *
 * Mirror of apps/backend/src/sentry-scrubber.ts. Keep these two files
 * in step: any sensitive key added there must be added here.
 *
 * The web client won't typically see env-named secrets (those live
 * server-side) but DOES see accessToken / refreshToken / otp values
 * in form state, service responses, and hook breadcrumbs. The
 * Authorization header goes over the wire in every authenticated
 * request; a Sentry capture of a fetch error could include the
 * request headers verbatim without this scrubber.
 */

const SENSITIVE_KEY_RE =
  /^(authorization|cookie|accesstoken|refreshtoken|otp|password|apikey|apisecret|secret|privatekey|secretkey|seedphrase|mnemonic|operatorsecret|loop_jwt_signing_key(_previous)?|gift_card_api_(key|secret)|database_url|sentry_dsn|discord_webhook_(orders|monitoring|admin_audit))$/i;

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
