import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const { state, executeMock } = vi.hoisted(() => {
  const state = {
    rows: [] as unknown,
    throwErr: null as Error | null,
  };
  const executeMock = vi.fn(async () => {
    if (state.throwErr !== null) throw state.throwErr;
    return state.rows;
  });
  return { state, executeMock };
});

vi.mock('../../db/client.js', () => ({
  db: { execute: executeMock },
}));

vi.mock('../../db/schema.js', () => ({
  orders: {
    merchantId: 'orders.merchant_id',
    state: 'orders.state',
    chargeCurrency: 'orders.charge_currency',
    userCashbackMinor: 'orders.user_cashback_minor',
    fulfilledAt: 'orders.fulfilled_at',
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = (await vi.importActual('drizzle-orm')) as Record<string, unknown>;
  return {
    ...actual,
    sql: Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
      {},
    ),
  };
});

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminMerchantCashbackMonthlyHandler } from '../merchant-cashback-monthly.js';

function makeCtx(params: Record<string, string | undefined> = {}): Context {
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
  state.rows = [];
  state.throwErr = null;
  executeMock.mockClear();
});

describe('adminMerchantCashbackMonthlyHandler', () => {
  it('400 when merchantId is missing', async () => {
    const res = await adminMerchantCashbackMonthlyHandler(makeCtx({}));
    expect(res.status).toBe(400);
  });

  it('400 when merchantId has disallowed characters', async () => {
    const res = await adminMerchantCashbackMonthlyHandler(makeCtx({ merchantId: 'bad slug' }));
    expect(res.status).toBe(400);
  });

  it('400 when merchantId exceeds 128 chars', async () => {
    const res = await adminMerchantCashbackMonthlyHandler(makeCtx({ merchantId: 'x'.repeat(200) }));
    expect(res.status).toBe(400);
  });

  it('200 with empty entries when the merchant has no fulfilled orders in the window', async () => {
    state.rows = [];
    const res = await adminMerchantCashbackMonthlyHandler(makeCtx({ merchantId: 'amazon_us' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merchantId: string; entries: unknown[] };
    expect(body.merchantId).toBe('amazon_us');
    expect(body.entries).toEqual([]);
  });

  it('maps rows into (month, currency, cashbackMinor) entries', async () => {
    state.rows = [
      { month: '2026-03-01 00:00:00+00', currency: 'USD', cashback_minor: '12000' },
      { month: '2026-04-01 00:00:00+00', currency: 'GBP', cashback_minor: 4500n },
    ];
    const res = await adminMerchantCashbackMonthlyHandler(makeCtx({ merchantId: 'amazon_us' }));
    const body = (await res.json()) as {
      entries: Array<{ month: string; currency: string; cashbackMinor: string }>;
    };
    expect(body.entries).toEqual([
      { month: '2026-03', currency: 'USD', cashbackMinor: '12000' },
      { month: '2026-04', currency: 'GBP', cashbackMinor: '4500' },
    ]);
  });

  it('formats Date-typed month values to "YYYY-MM"', async () => {
    state.rows = [
      {
        month: new Date(Date.UTC(2026, 0, 1)),
        currency: 'EUR',
        cashback_minor: '100',
      },
    ];
    const res = await adminMerchantCashbackMonthlyHandler(makeCtx({ merchantId: 'm-1' }));
    const body = (await res.json()) as { entries: Array<{ month: string }> };
    expect(body.entries[0]?.month).toBe('2026-01');
  });

  it('preserves bigint precision past 2^53', async () => {
    state.rows = [
      {
        month: '2026-04-01 00:00:00+00',
        currency: 'USD',
        cashback_minor: 9007199254740992n + 23n,
      },
    ];
    const res = await adminMerchantCashbackMonthlyHandler(makeCtx({ merchantId: 'm-1' }));
    const body = (await res.json()) as { entries: Array<{ cashbackMinor: string }> };
    expect(body.entries[0]?.cashbackMinor).toBe('9007199254741015');
  });

  it('handles the { rows } envelope shape', async () => {
    state.rows = {
      rows: [{ month: '2026-04-01 00:00:00+00', currency: 'USD', cashback_minor: '1000' }],
    };
    const res = await adminMerchantCashbackMonthlyHandler(makeCtx({ merchantId: 'm-1' }));
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toHaveLength(1);
  });

  it('500 when the db throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminMerchantCashbackMonthlyHandler(makeCtx({ merchantId: 'm-1' }));
    expect(res.status).toBe(500);
  });
});
