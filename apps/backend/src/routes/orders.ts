// /api/orders/* route mounts — A4-075, ADR 010, ADR 050
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { privateNoStoreResponse } from '../middleware/cache-control.js';
import { requireAuth } from '../auth/handler.js';
import { listOrdersHandler } from '../orders/list-handler.js';
import { getOrderHandler } from '../orders/get-handler.js';
import { orderBarcodeImageHandler } from '../orders/barcode-image-handler.js';
import { loopCreateOrderHandler } from '../orders/loop-handler.js';
import { loopGetOrderHandler, loopListOrdersHandler } from '../orders/loop-read-handlers.js';

export function mountOrderRoutes(app: Hono): void {
  // Cache-Control must precede requireAuth so 401s carry private, no-store
  app.use('/api/orders', privateNoStoreResponse);
  app.use('/api/orders/*', privateNoStoreResponse);

  app.use('/api/orders', requireAuth);
  app.use('/api/orders/*', requireAuth);

  // A4-075: literal routes before parameter siblings to prevent TrieRouter matching 'loop' as :id
  app.post(
    '/api/orders/loop',
    rateLimit('POST /api/orders/loop', 10, 60_000),
    loopCreateOrderHandler,
  );
  app.get('/api/orders', rateLimit('GET /api/orders', 60, 60_000), listOrdersHandler);
  // ADR 010: Loop-native list must register before /api/orders/:id
  app.get('/api/orders/loop', rateLimit('GET /api/orders/loop', 60, 60_000), loopListOrdersHandler);

  app.get(
    '/api/orders/loop/:id',
    rateLimit('GET /api/orders/loop/:id', 120, 60_000),
    loopGetOrderHandler,
  );
  app.get('/api/orders/:id', rateLimit('GET /api/orders/:id', 120, 60_000), getOrderHandler);
  // ADR 050: authed, reference-keyed barcode-image proxy
  app.get(
    '/api/orders/:id/barcode-image',
    rateLimit('GET /api/orders/:id/barcode-image', 60, 60_000),
    orderBarcodeImageHandler,
  );
}
