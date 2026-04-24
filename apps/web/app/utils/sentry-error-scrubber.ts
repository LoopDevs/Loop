/**
 * Sentry error-argument scrubber (A2-1312).
 *
 * `scrubSentryEvent` (A2-1308) runs at `Sentry.init({ beforeSend })`
 * and scrubs the final Sentry event. But React Router's ErrorBoundary
 * receives error objects from thrown loader responses — shapes like
 * `error.response: Response` or `error.cause: Response` — whose
 * bodies get serialised into the event envelope in ways the event-
 * level scrubber doesn't reach (Sentry's default serializer walks
 * the prototype chain; a Response body may end up as a string field
 * or as an extra attribute before `beforeSend` ever sees it).
 *
 * This helper runs BEFORE `Sentry.captureException` — it normalises
 * the thrown object so the scrubber at the `beforeSend` boundary
 * already has nothing to find:
 *   - A `Response` / `Request` passed directly as the error is
 *     replaced with an `Error` wrapper carrying just `{ status,
 *     url }` — enough for triage, without the body.
 *   - Any `.response` / `.cause` attached to a thrown `Error` that
 *     is itself a `Response` / `Request` gets stripped.
 *   - Email-shaped or bearer-shaped tokens in `.message` get
 *     redacted.
 *
 * Conservative: when we can't identify a safe transformation, we
 * pass the value through and rely on the event-level scrubber as
 * backup.
 */

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Bearer tokens, Stellar secret keys (starting S + 55 base32 chars),
// and raw Authorization headers. The 16+ hex rule avoids nuking a
// route like `/api/orders/abc1234def5678` by requiring 32+ chars.
const BEARER_RE = /Bearer\s+[A-Za-z0-9_.\-+/=]{16,}/g;
const STELLAR_SECRET_RE = /S[A-Z2-7]{55}/g;
const LONG_HEX_RE = /[a-fA-F0-9]{32,}/g;

export function scrubStringForSentry(s: string): string {
  return s
    .replace(EMAIL_RE, '[REDACTED_EMAIL]')
    .replace(BEARER_RE, '[REDACTED_BEARER]')
    .replace(STELLAR_SECRET_RE, '[REDACTED_STELLAR_SECRET]')
    .replace(LONG_HEX_RE, '[REDACTED_HEX]');
}

function isResponseOrRequest(value: unknown): boolean {
  return (
    (typeof Response !== 'undefined' && value instanceof Response) ||
    (typeof Request !== 'undefined' && value instanceof Request)
  );
}

/**
 * Normalises an arbitrary thrown value into something safe to pass
 * to `Sentry.captureException`. The return type is deliberately
 * `unknown` — callers pass it verbatim and Sentry handles whatever
 * shape lands.
 */
export function scrubErrorForSentry(err: unknown): unknown {
  if (isResponseOrRequest(err)) {
    const r = err as Response | Request;
    const wrapper = new Error(
      `Thrown ${r.constructor.name} from route loader — body suppressed for PII`,
    );
    (wrapper as Error & { responseMeta?: unknown }).responseMeta = {
      status: 'status' in r ? r.status : undefined,
      url: r.url,
    };
    return wrapper;
  }
  if (err instanceof Error) {
    // Clone so we don't mutate the original (caller may still use it
    // for UI state).
    const clone = new Error(scrubStringForSentry(err.message));
    clone.name = err.name;
    if (err.stack !== undefined) clone.stack = err.stack;
    const src = err as Error & { response?: unknown; cause?: unknown };
    if (src.response !== undefined && !isResponseOrRequest(src.response)) {
      (clone as Error & { response?: unknown }).response = src.response;
    }
    if (src.cause !== undefined && !isResponseOrRequest(src.cause)) {
      (clone as Error & { cause?: unknown }).cause = src.cause;
    }
    return clone;
  }
  if (typeof err === 'string') {
    return scrubStringForSentry(err);
  }
  return err;
}
