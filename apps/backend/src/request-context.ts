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
