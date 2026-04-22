import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { state } = vi.hoisted(() => ({
  state: {
    result: [] as Array<Record<string, unknown>> | { rows: Array<Record<string, unknown>> },
    throw: false,
  },
}));
vi.mock('../../db/client.js', () => ({
  db: {
    execute: vi.fn(async () => {
      if (state.throw) throw new Error('db exploded');
      return state.result;
    }),
  },
}));
vi.mock('../../db/schema.js', () => ({
  orders: {
    state: 'state',
    paymentMethod: 'payment_method',
    fulfilledAt: 'fulfilled_at',
  },
}));

import { publicFlywheelStatsHandler, __resetPublicFlywheelStatsCache } from '../flywheel-stats.js';

function makeCtx(): { c: Context; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const c = {
    req: {},
    header: (k: string, v: string) => {
      headers[k] = v;
    },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
  return { c, headers };
}

beforeEach(() => {
  state.result = [];
  state.throw = false;
  __resetPublicFlywheelStatsCache();
});

describe('publicFlywheelStatsHandler', () => {
  it('zero-activity fleet — returns fulfilled=0, recycled=0, pct="0.0"', async () => {
    state.result = [{ fulfilled: 0, recycled: 0 }];
    const { c, headers } = makeCtx();
    const res = await publicFlywheelStatsHandler(c);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      windowDays: 30,
      fulfilledOrders: 0,
      recycledOrders: 0,
      pctRecycled: '0.0',
    });
    expect(headers['Cache-Control']).toBe('public, max-age=300');
  });

  it('happy path — computes pctRecycled to one decimal', async () => {
    state.result = [{ fulfilled: 200, recycled: 30 }];
    const { c } = makeCtx();
    const res = await publicFlywheelStatsHandler(c);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      windowDays: 30,
      fulfilledOrders: 200,
      recycledOrders: 30,
      pctRecycled: '15.0',
    });
  });

  it('rounds 1/3 to "33.3"', async () => {
    state.result = [{ fulfilled: 3, recycled: 1 }];
    const { c } = makeCtx();
    const res = await publicFlywheelStatsHandler(c);
    const body = (await res.json()) as { pctRecycled: string };
    expect(body.pctRecycled).toBe('33.3');
  });

  it('coerces string-valued counts (postgres numeric/int8 driver quirks)', async () => {
    state.result = [{ fulfilled: '150', recycled: '45' }];
    const { c } = makeCtx();
    const res = await publicFlywheelStatsHandler(c);
    const body = (await res.json()) as { fulfilledOrders: number; recycledOrders: number };
    expect(body.fulfilledOrders).toBe(150);
    expect(body.recycledOrders).toBe(45);
  });

  it('handles the `{ rows }` envelope shape (driver parity)', async () => {
    state.result = { rows: [{ fulfilled: 10, recycled: 2 }] };
    const { c } = makeCtx();
    const res = await publicFlywheelStatsHandler(c);
    const body = (await res.json()) as { pctRecycled: string };
    expect(body.pctRecycled).toBe('20.0');
  });

  it('never-500 — db throw + no cache → zeroed response + 60s cache', async () => {
    state.throw = true;
    const { c, headers } = makeCtx();
    const res = await publicFlywheelStatsHandler(c);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      windowDays: 30,
      fulfilledOrders: 0,
      recycledOrders: 0,
      pctRecycled: '0.0',
    });
    expect(headers['Cache-Control']).toBe('public, max-age=60');
  });

  it('never-500 — serves last-known-good snapshot when db throws after a prior success', async () => {
    // Warm the cache with a successful response.
    state.result = [{ fulfilled: 100, recycled: 25 }];
    await publicFlywheelStatsHandler(makeCtx().c);

    // Next request: db throws. Must serve the warm snapshot, not zeros.
    state.throw = true;
    const { c, headers } = makeCtx();
    const res = await publicFlywheelStatsHandler(c);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pctRecycled: string; fulfilledOrders: number };
    expect(body.fulfilledOrders).toBe(100);
    expect(body.pctRecycled).toBe('25.0');
    expect(headers['Cache-Control']).toBe('public, max-age=60');
  });
});
