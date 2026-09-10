// Per-request context via AsyncLocalStorage — A2-1305
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
  /**
   * A2-1305 follow-up: the `X-Request-Id` (or `X-Correlation-Id`)
   * header from the most recent CTX response observed during this
   * request. `ctx/api-fetch.ts::ctxFetch` writes it after every
   * outbound CTX call; the post-handler middleware in `app.ts` reads
   * it and surfaces it back to the client as `X-Ctx-Request-Id`.
   *
   * Stored as a mutable field on the per-request context object so
   * the latest CTX response wins — when a single inbound request makes
   * multiple CTX calls, ops can trace the most recent CTX-side log
   * line against ours.
   */
  ctxRequestId?: string;
}

const als = new AsyncLocalStorage<RequestContext>();

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
