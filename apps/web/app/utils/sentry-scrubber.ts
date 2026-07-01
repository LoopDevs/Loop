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
 *
 * Sibling to `sentry-error-scrubber.ts` (A2-1312) — the two are
 * deliberately distinct, not duplicates:
 *   - THIS module is key-based and runs at the `Sentry.init({
 *     beforeSend })` boundary: it redacts sensitive *fields* on the
 *     final event envelope (headers, cookies, extra, tags).
 *   - `sentry-error-scrubber.ts` is value/pattern-based and runs
 *     BEFORE `Sentry.captureException`: it normalises the thrown
 *     object itself (Response/Request bodies, email / bearer / hex
 *     patterns inside message + stack strings) — shapes Sentry's
 *     serialiser folds into the envelope before beforeSend can see
 *     them as named keys.
 * Neither subsumes the other; both layers are required.
 *
 * **CF2-09 (2026-06-30 cold audit):** this file had drifted from the
 * backend twin in two ways, closed here:
 *   - `SentryEventLike` had no `breadcrumbs` field and `scrubSentryEvent`
 *     never touched them. Sentry's default integrations capture
 *     `console.*` calls as breadcrumbs automatically — any PII logged
 *     via `console.log`/`console.error` anywhere in the app (e.g. the
 *     native DSR export screen's now-fixed `console.log(payload)`,
 *     W30-02) reached Sentry completely unscrubbed. `beforeSend`
 *     receives the full event including `breadcrumbs`, so the fix
 *     lives here rather than in `sentry-error-scrubber.ts` (which only
 *     ever sees a single explicitly-thrown value, not Sentry's
 *     automatically-accumulated breadcrumb trail).
 *   - `SENSITIVE_KEY_RE` was missing `idempotencykey` / the header
 *     variants entirely (present on the backend since A4-039).
 *   - No free-text PII pass (email / bearer / Stellar secret / long
 *     hex) at the `beforeSend` layer at all — only the separate
 *     pre-`captureException` `scrubStringForSentry` pass caught those,
 *     which never sees breadcrumbs or events built outside that call
 *     site (e.g. `browserTracingIntegration`-captured errors,
 *     unhandled rejections). Reuses `scrubStringForSentry` here too
 *     (DRY — same regex set, single definition) rather than
 *     redefining the patterns a second time in this file.
 */
import { scrubStringForSentry } from './sentry-error-scrubber';

const SENSITIVE_KEY_RE =
  /^(authorization|cookie|accesstoken|refreshtoken|otp|password|apikey|apisecret|secret|privatekey|secretkey|seedphrase|mnemonic|operatorsecret|loop_jwt_signing_key(_previous)?|gift_card_api_(key|secret)|database_url|sentry_dsn|discord_webhook_(orders|monitoring|admin_audit)|idempotencykey|idempotency-key)$/i;

export interface SentryEventLike {
  message?: string;
  request?: {
    headers?: Record<string, unknown>;
    data?: unknown;
    cookies?: Record<string, unknown>;
  };
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  exception?: {
    values?: Array<{
      type?: string;
      value?: string;
      [k: string]: unknown;
    }>;
  };
  breadcrumbs?: Array<{
    message?: string;
    data?: Record<string, unknown>;
    [k: string]: unknown;
  }>;
}

export function scrubSentryEvent<T extends SentryEventLike>(event: T): T {
  try {
    const scrubbed = { ...event };
    if (event.message !== undefined) {
      scrubbed.message = scrubStringForSentry(event.message);
    }
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
    if (event.exception?.values !== undefined) {
      scrubbed.exception = {
        ...event.exception,
        values: event.exception.values.map((v) => ({
          ...v,
          ...(typeof v.value === 'string' ? { value: scrubStringForSentry(v.value) } : {}),
        })),
      };
    }
    if (event.breadcrumbs !== undefined) {
      scrubbed.breadcrumbs = event.breadcrumbs.map((b) => ({
        ...b,
        ...(typeof b.message === 'string' ? { message: scrubStringForSentry(b.message) } : {}),
        ...(b.data !== undefined ? { data: scrubObject(b.data) } : {}),
      }));
    }
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
