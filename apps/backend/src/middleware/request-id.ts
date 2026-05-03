/**
 * Request-id middleware (A4-008).
 *
 * Replaces Hono's stock `requestId()` to ignore inbound
 * `X-Request-Id` headers entirely. The stock middleware honours
 * the inbound value as long as it's ≤ 255 chars and matches
 * `/[\w\-=]/` — which lets a client pre-choose a request id and
 * pollute access logs / Sentry breadcrumbs / CTX upstream
 * correlation with a known string. They can also impersonate a
 * victim's correlation id to bury their trace in noise.
 *
 * This wrapper always generates a fresh `crypto.randomUUID()`
 * server-side and writes it to the response header, never
 * reading the inbound. Exported as `requestIdMiddleware` so
 * `app.ts` can mount it in place of `import { requestId } from
 * 'hono/request-id'`.
 *
 * Context shape: sets `c.get('requestId')` to the freshly-minted
 * UUID — same key Hono's middleware uses, so downstream readers
 * (access-log, request-context AsyncLocalStorage, circuit-breaker
 * outbound propagation) keep working without changes.
 *
 * Outbound header: `X-Request-Id: <uuid>` so clients can still
 * report a specific failure with the id Loop generated. Replaces
 * any inbound value verbatim.
 */
import type { Context } from 'hono';

const HEADER_NAME = 'X-Request-Id';

export async function requestIdMiddleware(c: Context, next: () => Promise<void>): Promise<void> {
  const id = crypto.randomUUID();
  c.set('requestId', id);
  c.header(HEADER_NAME, id);
  await next();
}
