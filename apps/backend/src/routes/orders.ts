/**
 * `/api/orders/*` route mounts. Pulled out of `app.ts` as the
 * fifth per-domain route module after public / misc / merchants
 * / auth.
 *
 * The orders surface bundles three things together because their
 * mount ORDER is the contract:
 *
 * 1. **Cache-Control: private, no-store** on every response —
 *    these contain a specific user's purchase history + gift-
 *    card redemption payloads. Without this, a CDN or proxy
 *    keyed on URL alone (not Authorization) could cache one
 *    user's `GET /api/orders` response and serve it to another
 *    user's next request. Fly.io itself doesn't proxy-cache,
 *    but this removes the footgun before any future edge cache
 *    is introduced.
 * 2. **`requireAuth`** — the per-route `requireAuth` mount HAS
 *    to come AFTER the cache-control mount so the 401 response
 *    `requireAuth` emits (when no Bearer is present) still
 *    carries the `private, no-store` header. A misbehaving CDN
 *    that caches 401s otherwise leaks the "this URL needs auth"
 *    shape across requests.
 * 3. **Per-route handlers** — both the legacy CTX-proxy paths
 *    (`/api/orders`, `/api/orders/:id`) and the Loop-native
 *    paths (`/api/orders/loop`, `/api/orders/loop/:id`) live in
 *    the same namespace. Loop-native paths are gated inside the
 *    handler on `LOOP_AUTH_NATIVE_ENABLED`; the legacy CTX-
 *    proxy path stays mounted unconditionally during the
 *    migration window.
 *
 * Per-IP rate-limit rationale (preserved verbatim):
 * - POST: 10/min — a user rarely creates more than one order
 *   per minute; 10 leaves room for retry-after-error.
 * - GET list: 60/min — the Orders page navigates.
 * - GET :id: 120/min — PaymentStep polls every 3s (~20/min);
 *   120 accommodates multiple pending orders + a retry burst.
 */
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { killSwitch } from '../middleware/kill-switch.js';
import { privateNoStoreResponse } from '../middleware/cache-control.js';
import { requireAuth } from '../auth/handler.js';
import { createOrderHandler, listOrdersHandler, getOrderHandler } from '../orders/handler.js';
import {
  loopCreateOrderHandler,
  loopGetOrderHandler,
  loopListOrdersHandler,
} from '../orders/loop-handler.js';

/** Mounts all `/api/orders/*` routes on the supplied Hono app. */
export function mountOrderRoutes(app: Hono): void {
  // Cache-Control mount first — must precede `requireAuth` so the
  // header lands on the 401 envelope too.
  app.use('/api/orders', privateNoStoreResponse);
  app.use('/api/orders/*', privateNoStoreResponse);

  app.use('/api/orders', requireAuth);
  app.use('/api/orders/*', requireAuth);

  // Legacy CTX-proxy order paths.
  app.post('/api/orders', killSwitch('orders'), rateLimit(10, 60_000), createOrderHandler);
  app.get('/api/orders', rateLimit(60, 60_000), listOrdersHandler);
  app.get('/api/orders/:id', rateLimit(120, 60_000), getOrderHandler);

  // Loop-native order creation (ADR 010). Distinct path so the
  // legacy CTX-proxy flow at POST /api/orders stays live during
  // the migration window. Gated inside the handler on
  // `LOOP_AUTH_NATIVE_ENABLED` — off → 404.
  app.post('/api/orders/loop', killSwitch('orders'), rateLimit(10, 60_000), loopCreateOrderHandler);

  // Loop-native orders list (ADR 010). Listed before :id so the
  // path param doesn't capture 'list' or similar; rate 60/min
  // matches the legacy /api/orders GET.
  app.get('/api/orders/loop', rateLimit(60, 60_000), loopListOrdersHandler);

  // Loop-native order GET. The UI polls this while an order is
  // `pending_payment → paid → procuring → fulfilled`, so the
  // rate is generous. Owner-scoped: the handler 404s on a
  // non-owner read so existence isn't leaked.
  app.get('/api/orders/loop/:id', rateLimit(120, 60_000), loopGetOrderHandler);
}
