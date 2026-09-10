// Pino access-log middleware — A-021, A2-1321, A2-1529, A4-008
import type { Context } from 'hono';
import { logger } from '../logger.js';

const SILENT_PROBE_PATHS = new Set(['/health', '/metrics', '/openapi.json']);

const accessLog = logger.child({ component: 'access' });

export async function accessLogMiddleware(c: Context, next: () => Promise<void>): Promise<void> {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  const status = c.res.status;
  // A2-1321: skip successful probes to avoid log flooding.
  if (SILENT_PROBE_PATHS.has(c.req.path) && status < 400) return;
  // A2-1529: forward client-id headers when present.
  const clientVersion = c.req.header('X-Client-Version');
  const clientId = c.req.header('X-Client-Id');
  accessLog.info(
    {
      method: c.req.method,
      path: c.req.path,
      status,
      durationMs: ms,
      // A4-008: server-minted UUID only; prevents attacker-controlled log injection.
      requestId: c.get('requestId'),
      ...(clientVersion !== undefined ? { clientVersion } : {}),
      ...(clientId !== undefined ? { clientId } : {}),
    },
    `${c.req.method} ${c.req.path} ${status} ${ms}ms`,
  );
}
