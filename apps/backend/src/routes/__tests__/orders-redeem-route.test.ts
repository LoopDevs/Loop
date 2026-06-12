import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * Route-mount pin for the ADR 036 redeem rename: the one-tap
 * redemption endpoint lives at `POST /api/orders/loop/:id/redeem`
 * and the pre-rename `/pay-with-balance` path is GONE (404 from the
 * app-level fallback) — nothing was deployed, so there is no compat
 * alias. Handlers + middleware are mocked: this test pins the route
 * table, not handler behaviour (that's `orders/__tests__/redeem.test.ts`).
 */

// Pass-through middleware stand-ins — the route table is the subject.
vi.mock('../../middleware/rate-limit.js', () => ({
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../../middleware/kill-switch.js', () => ({
  killSwitch: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../../middleware/cache-control.js', () => ({
  privateNoStoreResponse: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../../auth/handler.js', () => ({
  requireAuth: async (_c: unknown, next: () => Promise<void>) => next(),
}));

// Handler stand-ins: each route answers with its own marker so the
// assertion proves which mount matched.
vi.mock('../../orders/handler.js', () => ({
  createOrderHandler: (c: { json: (b: unknown) => Response }) => c.json({ route: 'legacy-create' }),
  listOrdersHandler: (c: { json: (b: unknown) => Response }) => c.json({ route: 'legacy-list' }),
  getOrderHandler: (c: { json: (b: unknown) => Response }) => c.json({ route: 'legacy-get' }),
}));
vi.mock('../../orders/loop-handler.js', () => ({
  loopCreateOrderHandler: (c: { json: (b: unknown) => Response }) =>
    c.json({ route: 'loop-create' }),
  loopGetOrderHandler: (c: { json: (b: unknown) => Response }) => c.json({ route: 'loop-get' }),
  loopListOrdersHandler: (c: { json: (b: unknown) => Response }) => c.json({ route: 'loop-list' }),
}));
vi.mock('../../orders/redeem.js', () => ({
  redeemLoopOrderHandler: (c: { json: (b: unknown) => Response }) => c.json({ route: 'redeem' }),
}));

import { mountOrderRoutes } from '../orders.js';

const ORDER_ID = '0f0e0d0c-0b0a-4990-8877-665544332211';

function buildApp(): Hono {
  const app = new Hono();
  mountOrderRoutes(app);
  return app;
}

describe('POST /api/orders/loop/:id/redeem route mount (ADR 036 rename)', () => {
  it('reaches the redeem handler at the new path', async () => {
    const app = buildApp();
    const res = await app.request(`/api/orders/loop/${ORDER_ID}/redeem`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ route: 'redeem' });
  });

  it('404s the old /pay-with-balance path — clean rename, no compat alias', async () => {
    const app = buildApp();
    const res = await app.request(`/api/orders/loop/${ORDER_ID}/pay-with-balance`, {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });
});
