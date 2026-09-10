// misc single-mount routes — ADR 010, ADR 013
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { clustersHandler } from '../clustering/handler.js';
import { configHandler } from '../config/handler.js';
import { imageProxyHandler } from '../images/proxy.js';

export function mountMiscRoutes(app: Hono): void {
  app.get('/api/clusters', rateLimit('GET /api/clusters', 60, 60_000), clustersHandler);
  app.get('/api/config', rateLimit('GET /api/config', 120, 60_000), configHandler);
  app.get('/api/image', rateLimit('GET /api/image', 300, 60_000), imageProxyHandler);
}
