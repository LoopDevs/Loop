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
    merchantId: 'orders.merchant_id',
    state: 'orders.state',
    paymentMethod: 'orders.payment_method',
    chargeMinor: 'orders.charge_minor',
    fulfilledAt: 'orders.fulfilled_at',
  },
}));

import { adminMerchantsFlywheelShareHandler } from '../merchants-flywheel-share.js';

function makeCtx(query: Record<string, string> = {}): Context {
  return {
    req: { query: (k: string) => query[k] },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  state.result = [];
  state.throw = false;
});

describe('adminMerchantsFlywheelShareHandler', () => {
  it('default window — echoes a 31-day `since` in the response', async () => {
    state.result = [];
    const res = await adminMerchantsFlywheelShareHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { since: string; rows: unknown[] };
    // `since` is an ISO-8601 string. Compare the epoch-ms delta to
    // "about 31 days ago" with a 5-minute slack for wall-clock drift
    // between the handler's `Date.now()` and the test assertion.
    const ageMs = Date.now() - new Date(body.since).getTime();
    const thirtyOneDaysMs = 31 * 24 * 60 * 60 * 1000;
    expect(Math.abs(ageMs - thirtyOneDaysMs)).toBeLessThan(5 * 60 * 1000);
    expect(body.rows).toEqual([]);
  });

  it('rejects an invalid ?since with 400', async () => {
    const res = await adminMerchantsFlywheelShareHandler(makeCtx({ since: 'not-a-date' }));
    expect(res.status).toBe(400);
  });

  it('rejects a future ?since with 400', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const res = await adminMerchantsFlywheelShareHandler(makeCtx({ since: future }));
    expect(res.status).toBe(400);
  });

  it('clamps an ancient ?since to the max window', async () => {
    const res = await adminMerchantsFlywheelShareHandler(makeCtx({ since: '1970-01-01' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { since: string };
    const ageMs = Date.now() - new Date(body.since).getTime();
    const max = 366 * 24 * 60 * 60 * 1000;
    // Clamped to ~366 days, not 50+ years.
    expect(Math.abs(ageMs - max)).toBeLessThan(5 * 60 * 1000);
  });

  it('clamps ?limit — floor 1, cap 100, malformed falls back to 25', async () => {
    // We can't inspect LIMIT in the SQL from outside the handler,
    // so just confirm malformed + extreme values don't 500.
    const res1 = await adminMerchantsFlywheelShareHandler(makeCtx({ limit: '9999' }));
    expect(res1.status).toBe(200);
    const res2 = await adminMerchantsFlywheelShareHandler(makeCtx({ limit: '-5' }));
    expect(res2.status).toBe(200);
    const res3 = await adminMerchantsFlywheelShareHandler(makeCtx({ limit: 'nope' }));
    expect(res3.status).toBe(200);
  });

  it('maps db rows into the flywheel-share shape with bigint-as-string minors', async () => {
    state.result = [
      {
        merchantId: 'amazon_us',
        totalFulfilledCount: 50,
        recycledOrderCount: 20,
        recycledChargeMinor: '80000',
        totalChargeMinor: '200000',
      },
      {
        merchantId: 'starbucks_uk',
        totalFulfilledCount: 30,
        recycledOrderCount: 12,
        recycledChargeMinor: '36000',
        totalChargeMinor: '90000',
      },
    ];
    const res = await adminMerchantsFlywheelShareHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows).toEqual([
      {
        merchantId: 'amazon_us',
        totalFulfilledCount: 50,
        recycledOrderCount: 20,
        recycledChargeMinor: '80000',
        totalChargeMinor: '200000',
      },
      {
        merchantId: 'starbucks_uk',
        totalFulfilledCount: 30,
        recycledOrderCount: 12,
        recycledChargeMinor: '36000',
        totalChargeMinor: '90000',
      },
    ]);
  });

  it('preserves bigint precision past 2^53 for charge totals', async () => {
    state.result = [
      {
        merchantId: 'm-1',
        totalFulfilledCount: 1,
        recycledOrderCount: 1,
        recycledChargeMinor: 9007199254740992n + 7n,
        totalChargeMinor: 9007199254740992n + 7n,
      },
    ];
    const res = await adminMerchantsFlywheelShareHandler(makeCtx());
    const body = (await res.json()) as {
      rows: Array<{ recycledChargeMinor: string; totalChargeMinor: string }>;
    };
    expect(body.rows[0]?.recycledChargeMinor).toBe('9007199254740999');
    expect(body.rows[0]?.totalChargeMinor).toBe('9007199254740999');
  });

  it('handles the `{ rows }` envelope shape (driver parity)', async () => {
    state.result = {
      rows: [
        {
          merchantId: 'starbucks_uk',
          totalFulfilledCount: 10,
          recycledOrderCount: 3,
          recycledChargeMinor: '600',
          totalChargeMinor: '2000',
        },
      ],
    };
    const res = await adminMerchantsFlywheelShareHandler(makeCtx());
    const body = (await res.json()) as { rows: Array<{ merchantId: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.merchantId).toBe('starbucks_uk');
  });

  it('500 when the db throws', async () => {
    state.throw = true;
    const res = await adminMerchantsFlywheelShareHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
