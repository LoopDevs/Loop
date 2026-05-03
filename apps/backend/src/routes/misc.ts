/**
 * Three single-mount routes that don't fit a larger namespace:
 *
 * - `GET /api/clusters` — map clustering for the cashback merchant
 *   directory. 60/min per IP because each cluster request iterates
 *   every cached location and computes centroids; real clients are
 *   debounced at 300ms in ClusterMap so 60/min leaves them plenty
 *   of headroom while stopping a bot from spamming varied bounds/
 *   zoom to pressure the backend.
 * - `GET /api/config` — small object of feature flags the web
 *   client needs to decide which code paths to take (ADR 010 /
 *   ADR 013). Unauthenticated — the client needs this before
 *   login. 120/min generous; the response is `Cache-Control:
 *   max-age=600` so a healthy client hits it rarely.
 * - `GET /api/image` — image proxy. 300/min per IP because
 *   images load progressively (lazy + cached), not all at once.
 *
 * Bundled into one route module rather than three separate
 * `routes/clusters.ts` / `routes/config.ts` / `routes/image.ts`
 * because each is only one mount; per-domain modules are for
 * cohesive surfaces (auth, orders, admin), and a single-mount
 * file would just be three lines of import + factory wrapper
 * around one app.get call.
 */
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { clustersHandler } from '../clustering/handler.js';
import { configHandler } from '../config/handler.js';
import { imageProxyHandler } from '../images/proxy.js';

/**
 * Mounts `/api/clusters` + `/api/config` + `/api/image` on the
 * supplied Hono app.
 */
export function mountMiscRoutes(app: Hono): void {
  app.get('/api/clusters', rateLimit('GET /api/clusters', 60, 60_000), clustersHandler);
  app.get('/api/config', rateLimit('GET /api/config', 120, 60_000), configHandler);
  app.get('/api/image', rateLimit('GET /api/image', 300, 60_000), imageProxyHandler);
}
