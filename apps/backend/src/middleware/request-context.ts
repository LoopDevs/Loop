/**
 * AsyncLocalStorage request-context wrapper (A2-1305). Mounts
 * the per-request `requestId` into an ALS scope so any downstream
 * helper — `operatorFetch`, `CircuitBreaker.fetch`, handler-scope
 * code that doesn't pass `c` around — can read it and propagate
 * it onto outbound CTX fetches as `X-Request-Id`. CTX then logs
 * our id against theirs, letting ops ask "what happened to our
 * request abc123?" without a timestamp-only dig.
 *
 * Mount order: this middleware MUST come after Hono's
 * `requestId()` so `c.get('requestId')` is populated, and BEFORE
 * the access-log middleware so the log line reads its
 * `requestId` from the ALS-populated context.
 *
 * The response-side X-Ctx-Request-Id propagation is the second
 * half of the contract: `circuit-breaker.ts::wrappedFetch`
 * captures the `X-Request-Id` (or `X-Correlation-Id`) header
 * from every CTX response into the per-request store; this
 * middleware reads the most recent one out — last-write wins
 * when a single inbound request fires multiple CTX calls (e.g.
 * a circuit half-open retry). Skipped silently when no CTX call
 * happened — most non-proxy endpoints (health, admin reads)
 * won't emit the header.
 *
 * The READ has to happen INSIDE the `als.run` callback —
 * `getCtxResponseRequestId()` only sees the per-request store
 * while we're still under `als.run`. Reading after
 * `runWithRequestContext` returns gets `undefined` because node
 * has already torn the store back down.
 */
import type { Context } from 'hono';
import { runWithRequestContext, getCtxResponseRequestId } from '../request-context.js';

/**
 * Hono middleware: wraps the handler chain in an ALS scope keyed
 * on `requestId`, then sets the captured CTX response request-id
 * back as `X-Ctx-Request-Id` on our response so external ops
 * tooling can correlate.
 */
export async function requestContextMiddleware(
  c: Context,
  next: () => Promise<void>,
): Promise<void> {
  const id = c.get('requestId') ?? c.req.header('X-Request-Id') ?? 'unknown';
  await runWithRequestContext({ requestId: id }, async () => {
    await next();
    const ctxId = getCtxResponseRequestId();
    if (ctxId !== undefined) c.res.headers.set('X-Ctx-Request-Id', ctxId);
  });
}
