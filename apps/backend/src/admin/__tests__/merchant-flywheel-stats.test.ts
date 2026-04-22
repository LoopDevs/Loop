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

import { adminMerchantFlywheelStatsHandler } from '../merchant-flywheel-stats.js';

function makeCtx(params: Record<string, string> = {}): Context {
  return {
    req: { param: (k: string) => params[k] },
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

describe('adminMerchantFlywheelStatsHandler', () => {
  it('400 when merchantId is missing', async () => {
    const res = await adminMerchantFlywheelStatsHandler(makeCtx({}));
    expect(res.status).toBe(400);
  });

  it('400 when merchantId has disallowed characters', async () => {
    const res = await adminMerchantFlywheelStatsHandler(makeCtx({ merchantId: 'has spaces' }));
    expect(res.status).toBe(400);
  });

  it('400 when merchantId is over the 128-char cap', async () => {
    const res = await adminMerchantFlywheelStatsHandler(makeCtx({ merchantId: 'x'.repeat(200) }));
    expect(res.status).toBe(400);
  });

  it('happy path — returns recycled + total counts + charges as bigint strings', async () => {
    state.result = [
      {
        totalFulfilledCount: 50,
        recycledOrderCount: 12,
        recycledChargeMinor: '36000',
        totalChargeMinor: '150000',
      },
    ];
    const res = await adminMerchantFlywheelStatsHandler(makeCtx({ merchantId: 'amazon_us' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.merchantId).toBe('amazon_us');
    expect(body.totalFulfilledCount).toBe(50);
    expect(body.recycledOrderCount).toBe(12);
    expect(body.recycledChargeMinor).toBe('36000');
    expect(body.totalChargeMinor).toBe('150000');
    // `since` is 31 days ago — compare within a 5-minute slack.
    const ageMs = Date.now() - new Date(body.since as string).getTime();
    const thirtyOne = 31 * 24 * 60 * 60 * 1000;
    expect(Math.abs(ageMs - thirtyOne)).toBeLessThan(5 * 60 * 1000);
  });

  it('zero-volume merchant — returns zeros, not 404', async () => {
    state.result = [
      {
        totalFulfilledCount: 0,
        recycledOrderCount: 0,
        recycledChargeMinor: '0',
        totalChargeMinor: '0',
      },
    ];
    const res = await adminMerchantFlywheelStatsHandler(makeCtx({ merchantId: 'empty_merchant' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      merchantId: 'empty_merchant',
      totalFulfilledCount: 0,
      recycledOrderCount: 0,
      recycledChargeMinor: '0',
      totalChargeMinor: '0',
    });
  });

  it('preserves bigint precision past 2^53', async () => {
    state.result = [
      {
        totalFulfilledCount: 1,
        recycledOrderCount: 1,
        recycledChargeMinor: 9007199254740992n + 7n,
        totalChargeMinor: 9007199254740992n + 7n,
      },
    ];
    const res = await adminMerchantFlywheelStatsHandler(makeCtx({ merchantId: 'm-1' }));
    const body = (await res.json()) as {
      recycledChargeMinor: string;
      totalChargeMinor: string;
    };
    expect(body.recycledChargeMinor).toBe('9007199254740999');
    expect(body.totalChargeMinor).toBe('9007199254740999');
  });

  it('handles the `{ rows }` envelope shape', async () => {
    state.result = {
      rows: [
        {
          totalFulfilledCount: 3,
          recycledOrderCount: 1,
          recycledChargeMinor: '100',
          totalChargeMinor: '300',
        },
      ],
    };
    const res = await adminMerchantFlywheelStatsHandler(makeCtx({ merchantId: 'm-1' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recycledOrderCount: number };
    expect(body.recycledOrderCount).toBe(1);
  });

  it('500 when the db throws', async () => {
    state.throw = true;
    const res = await adminMerchantFlywheelStatsHandler(makeCtx({ merchantId: 'm-1' }));
    expect(res.status).toBe(500);
  });
});
