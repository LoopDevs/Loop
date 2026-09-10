// per-request counter — A-022, A4-048
import type { Context } from 'hono';
import { incrementRequest, recordRequestDuration } from '../metrics.js';

export async function requestCounterMiddleware(
  c: Context,
  next: () => Promise<void>,
): Promise<void> {
  const startMs = performance.now();
  await next();
  if (c.req.path === '/metrics') return;
  const raw = c.req.routePath;
  const route = raw === undefined || raw === '/*' || raw === '*' ? 'NOT_FOUND' : raw;
  incrementRequest(c.req.method, route, c.res.status);
  recordRequestDuration(c.req.method, route, (performance.now() - startMs) / 1000);
}
