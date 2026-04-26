/**
 * Per-request context via AsyncLocalStorage (A2-1305).
 *
 * Hono's `requestId()` middleware stores the ID in `c.get('requestId')`,
 * which is reachable only where a handler has `c` in scope. But outbound
 * fetches happen inside helpers (`operatorFetch`, `CircuitBreaker.fetch`)
 * that don't see the Hono context, so there was no way to thread the
 * request ID onto the outbound headers — CTX could not correlate our
 * request with theirs when we asked "what happened to our order xyz?"
 *
 * This module exposes a node AsyncLocalStorage keyed on `{ requestId }`.
 * The access-log middleware in `app.ts` runs `runWithRequestContext`
 * around each request body, so anywhere deeper in the call stack can
 * call `getCurrentRequestId()` without plumbing.
 *
 * Scope is deliberately minimal: just the request ID. If we later need
 * user / trace-parent / client-version in the context, extend the
 * `RequestContext` shape and update the middleware.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
  /**
   * A2-1305 follow-up: the `X-Request-Id` (or `X-Correlation-Id`)
   * header from the most recent CTX response observed during this
   * request. `circuit-breaker.ts::wrappedFetch` writes it after every
   * outbound CTX call; the post-handler middleware in `app.ts` reads
   * it and surfaces it back to the client as `X-Ctx-Request-Id`.
   *
   * Stored as a mutable field on the per-request context object so
   * the latest CTX response wins — when a single inbound request makes
   * multiple CTX calls (e.g. retry on circuit half-open), ops can
   * trace the most recent CTX-side log line against ours.
   */
  ctxRequestId?: string;
}

const als = new AsyncLocalStorage<RequestContext>();

/**
 * Binds the given context to the current async call tree and runs
 * `fn` inside it. All descendant awaits / timers / fetches can read
 * the context via `getCurrentRequestId()`. Returns whatever `fn`
 * resolves to.
 */
export function runWithRequestContext<T>(
  ctx: RequestContext,
  fn: () => T | Promise<T>,
): Promise<T> {
  return Promise.resolve(als.run(ctx, fn));
}

/** Returns the request ID for the ambient async call, or `undefined` outside one. */
export function getCurrentRequestId(): string | undefined {
  return als.getStore()?.requestId;
}

/**
 * Records the CTX-side request ID seen on an outbound CTX response so
 * the post-handler middleware can echo it back to the client.
 * No-op outside a request context (e.g. background workers).
 */
export function setCtxResponseRequestId(id: string): void {
  const store = als.getStore();
  if (store !== undefined) store.ctxRequestId = id;
}

/** Returns the most recent CTX response request ID for the ambient request, or `undefined`. */
export function getCtxResponseRequestId(): string | undefined {
  return als.getStore()?.ctxRequestId;
}
