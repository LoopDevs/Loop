// AsyncLocalStorage request-context wrapper — A2-1305
import type { Context } from 'hono';
import { runWithRequestContext, getCtxResponseRequestId } from '../request-context.js';

// Mount after Hono's `requestId()` and before access-log middleware.
export async function requestContextMiddleware(
  c: Context,
  next: () => Promise<void>,
): Promise<void> {
  const id = c.get('requestId') ?? c.req.header('X-Request-Id') ?? 'unknown';
  await runWithRequestContext({ requestId: id }, async () => {
    await next();
    // Must read inside `als.run` — store is torn down after return.
    const ctxId = getCtxResponseRequestId();
    if (ctxId !== undefined) c.res.headers.set('X-Ctx-Request-Id', ctxId);
  });
}
