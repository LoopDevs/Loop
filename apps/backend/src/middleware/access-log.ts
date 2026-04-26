/**
 * Pino-backed access-log middleware. Pulled out of `app.ts`
 * (audit A-021) so request logs share the same structure,
 * redaction list, and transport as the rest of the backend.
 *
 * Correlates with handler-side logs via the `requestId` context
 * variable that Hono's `requestId()` middleware sets — that
 * middleware writes the id to the response header and the
 * context var but does NOT mutate the incoming request's
 * headers, so reading `c.req.header('X-Request-Id')` would be
 * undefined for every client that didn't already send one
 * (almost all of them). The mount in `app.ts` is responsible for
 * registering `requestId()` before `accessLog()` so the context
 * var is populated by the time we read it here.
 *
 * Two policy details encoded in this middleware:
 * - **A2-1321 silent probes**: Fly load balancer, Prometheus
 *   scraper, and openapi clients poll `/health`, `/metrics`,
 *   `/openapi.json` every few seconds. The fly.toml healthcheck
 *   alone fires every 15s per machine. Logging every 2xx balloons
 *   the Pino stream by ~5,760 lines/day/machine with no operator
 *   signal — the same counts are already on `/metrics`. We skip
 *   successful probes, keep 4xx/5xx so a sick probe path still
 *   surfaces.
 * - **A2-1529 client-id forwarding**: record the
 *   `X-Client-Version` + `X-Client-Id` headers so a prod
 *   regression can be scoped ("only v0.3.1 hits this 502") and a
 *   mobile rollout is visible in the access log without
 *   User-Agent inference. Both are best-effort: backend must
 *   tolerate their absence (curl, ops tooling) so we forward
 *   whatever's present and let the log consumer join.
 */
import type { Context } from 'hono';
import { logger } from '../logger.js';

/**
 * Probe paths that bypass the 2xx access log. Successful polls
 * here would dominate the log volume without surfacing operator
 * signal. 4xx/5xx are still logged so a sick probe gets caught.
 */
const SILENT_PROBE_PATHS = new Set(['/health', '/metrics', '/openapi.json']);

const accessLog = logger.child({ component: 'access' });

/**
 * Hono middleware that writes one structured access-log line per
 * non-silent request after the handler resolves. Mount with
 * `app.use('*', accessLogMiddleware)` after `requestId()` so the
 * `requestId` context var is populated.
 */
export async function accessLogMiddleware(c: Context, next: () => Promise<void>): Promise<void> {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  const status = c.res.status;
  // A2-1321: skip successful probe paths so Fly/Prometheus/OpenAPI
  // pollers don't flood the access log. Keep 4xx/5xx so a sick
  // probe path still surfaces.
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
      requestId: c.get('requestId') ?? c.req.header('X-Request-Id'),
      ...(clientVersion !== undefined ? { clientVersion } : {}),
      ...(clientId !== undefined ? { clientId } : {}),
    },
    `${c.req.method} ${c.req.path} ${status} ${ms}ms`,
  );
}
