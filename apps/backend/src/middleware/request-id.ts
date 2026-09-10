// Request-id middleware — A4-008
import type { Context } from 'hono';

const HEADER_NAME = 'X-Request-Id';

export async function requestIdMiddleware(c: Context, next: () => Promise<void>): Promise<void> {
  // Ignore inbound X-Request-Id to prevent clients from pre-choosing IDs to pollute logs or impersonate victims
  const id = crypto.randomUUID();
  c.set('requestId', id);
  c.header(HEADER_NAME, id);
  await next();
}
