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
    chargeCurrency: 'orders.charge_currency',
    chargeMinor: 'orders.charge_minor',
    userCashbackMinor: 'orders.user_cashback_minor',
  },
}));

import { adminMerchantCashbackSummaryHandler } from '../merchant-cashback-summary.js';

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

describe('adminMerchantCashbackSummaryHandler', () => {
  it('400 when merchantId is missing', async () => {
    const res = await adminMerchantCashbackSummaryHandler(makeCtx({}));
    expect(res.status).toBe(400);
  });

  it('400 when merchantId has disallowed characters', async () => {
    const res = await adminMerchantCashbackSummaryHandler(makeCtx({ merchantId: 'has spaces' }));
    expect(res.status).toBe(400);
  });

  it('400 when merchantId exceeds 128 chars', async () => {
    const res = await adminMerchantCashbackSummaryHandler(makeCtx({ merchantId: 'x'.repeat(200) }));
    expect(res.status).toBe(400);
  });

  it('happy path — returns per-currency buckets sorted by fulfilledCount desc', async () => {
    state.result = [
      {
        currency: 'USD',
        fulfilledCount: 50,
        lifetimeCashbackMinor: '15000',
        lifetimeChargeMinor: '250000',
      },
      {
        currency: 'GBP',
        fulfilledCount: 12,
        lifetimeCashbackMinor: '3600',
        lifetimeChargeMinor: '60000',
      },
    ];
    const res = await adminMerchantCashbackSummaryHandler(makeCtx({ merchantId: 'amazon_us' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      merchantId: string;
      totalFulfilledCount: number;
      currencies: Array<{
        currency: string;
        fulfilledCount: number;
        lifetimeCashbackMinor: string;
        lifetimeChargeMinor: string;
      }>;
    };
    expect(body.merchantId).toBe('amazon_us');
    expect(body.totalFulfilledCount).toBe(62);
    expect(body.currencies).toEqual([
      {
        currency: 'USD',
        fulfilledCount: 50,
        lifetimeCashbackMinor: '15000',
        lifetimeChargeMinor: '250000',
      },
      {
        currency: 'GBP',
        fulfilledCount: 12,
        lifetimeCashbackMinor: '3600',
        lifetimeChargeMinor: '60000',
      },
    ]);
  });

  it('zero-volume merchant — returns empty currencies list, not 404', async () => {
    state.result = [];
    const res = await adminMerchantCashbackSummaryHandler(
      makeCtx({ merchantId: 'empty_merchant' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totalFulfilledCount: number; currencies: unknown[] };
    expect(body.totalFulfilledCount).toBe(0);
    expect(body.currencies).toEqual([]);
  });

  it('preserves bigint precision past 2^53', async () => {
    state.result = [
      {
        currency: 'USD',
        fulfilledCount: 1,
        lifetimeCashbackMinor: 9007199254740992n + 13n,
        lifetimeChargeMinor: 9007199254740992n + 13n,
      },
    ];
    const res = await adminMerchantCashbackSummaryHandler(makeCtx({ merchantId: 'm-1' }));
    const body = (await res.json()) as {
      currencies: Array<{ lifetimeCashbackMinor: string; lifetimeChargeMinor: string }>;
    };
    const [first] = body.currencies;
    expect(first).toBeDefined();
    expect(first?.lifetimeCashbackMinor).toBe('9007199254741005');
    expect(first?.lifetimeChargeMinor).toBe('9007199254741005');
  });

  it('handles the `{ rows }` envelope shape', async () => {
    state.result = {
      rows: [
        {
          currency: 'USD',
          fulfilledCount: 3,
          lifetimeCashbackMinor: '90',
          lifetimeChargeMinor: '300',
        },
      ],
    };
    const res = await adminMerchantCashbackSummaryHandler(makeCtx({ merchantId: 'm-1' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totalFulfilledCount: number };
    expect(body.totalFulfilledCount).toBe(3);
  });

  it('500 when the db throws', async () => {
    state.throw = true;
    const res = await adminMerchantCashbackSummaryHandler(makeCtx({ merchantId: 'm-1' }));
    expect(res.status).toBe(500);
  });
});
