import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  rows: [] as unknown,
  throwErr: null as Error | null,
}));

vi.mock('../../db/client.js', () => ({
  db: {
    execute: vi.fn(async () => {
      if (state.throwErr !== null) throw state.throwErr;
      return state.rows;
    }),
  },
}));

vi.mock('../../db/schema.js', () => ({
  orders: {
    state: 'orders.state',
    chargeCurrency: 'orders.charge_currency',
    chargeMinor: 'orders.charge_minor',
    wholesaleMinor: 'orders.wholesale_minor',
    userCashbackMinor: 'orders.user_cashback_minor',
    loopMarginMinor: 'orders.loop_margin_minor',
  },
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminSupplierMarginHandler, marginBps } from '../supplier-margin.js';

function makeCtx(): Context {
  return {
    req: { query: (_k: string) => undefined, param: (_k: string) => undefined },
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
});

describe('marginBps', () => {
  it('returns 0 on zero charge', () => {
    expect(marginBps(0n, 0n)).toBe(0);
    expect(marginBps(0n, 100n)).toBe(0);
  });

  it('computes loopMargin / charge × 10 000', () => {
    expect(marginBps(10_000n, 100n)).toBe(100); // 1.00%
    expect(marginBps(10_000n, 500n)).toBe(500); // 5.00%
    expect(marginBps(10_000n, 1500n)).toBe(1500); // 15.00%
  });

  it('clamps overflow + negative margin', () => {
    expect(marginBps(100n, 200n)).toBe(10_000);
    expect(marginBps(100n, -50n)).toBe(0);
  });
});

describe('adminSupplierMarginHandler', () => {
  it('returns only the fleet-wide row when the ledger is empty', async () => {
    state.rows = [
      {
        currency: null,
        charge: '0',
        wholesale: '0',
        user_cashback: '0',
        loop_margin: '0',
        order_count: 0,
      },
    ];
    const res = await adminSupplierMarginHandler(makeCtx());
    const body = (await res.json()) as { rows: Array<{ currency: string | null }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!.currency).toBeNull();
  });

  it('maps per-currency + fleet rows with marginBps computed', async () => {
    state.rows = [
      {
        currency: null,
        charge: '300000',
        wholesale: '240000',
        user_cashback: '45000',
        loop_margin: '15000',
        order_count: 30,
      },
      {
        currency: 'USD',
        charge: '200000',
        wholesale: '160000',
        user_cashback: '30000',
        loop_margin: '10000',
        order_count: 20,
      },
      {
        currency: 'GBP',
        charge: '100000',
        wholesale: '80000',
        user_cashback: '15000',
        loop_margin: '5000',
        order_count: 10,
      },
    ];
    const res = await adminSupplierMarginHandler(makeCtx());
    const body = (await res.json()) as {
      rows: Array<{
        currency: string | null;
        chargeMinor: string;
        loopMarginMinor: string;
        orderCount: number;
        marginBps: number;
      }>;
    };
    expect(body.rows).toHaveLength(3);
    // Fleet: 15000 / 300000 × 10000 = 500 bps (5.00%)
    const fleet = body.rows.find((r) => r.currency === null)!;
    expect(fleet.marginBps).toBe(500);
    expect(fleet.orderCount).toBe(30);
    // USD: 10000 / 200000 × 10000 = 500 bps
    const usd = body.rows.find((r) => r.currency === 'USD')!;
    expect(usd.marginBps).toBe(500);
  });

  it('omits per-currency rows with zero charge (no fulfilled orders yet)', async () => {
    state.rows = [
      {
        currency: null,
        charge: '100',
        wholesale: '80',
        user_cashback: '15',
        loop_margin: '5',
        order_count: 1,
      },
      {
        currency: 'USD',
        charge: '100',
        wholesale: '80',
        user_cashback: '15',
        loop_margin: '5',
        order_count: 1,
      },
      {
        // Zero charge in this currency — should be omitted.
        currency: 'GBP',
        charge: '0',
        wholesale: '0',
        user_cashback: '0',
        loop_margin: '0',
        order_count: 0,
      },
    ];
    const res = await adminSupplierMarginHandler(makeCtx());
    const body = (await res.json()) as { rows: Array<{ currency: string | null }> };
    expect(body.rows).toHaveLength(2);
    expect(body.rows.map((r) => r.currency)).toEqual(expect.arrayContaining([null, 'USD']));
  });

  it('accepts bigint order_count (pg driver returns bigint for ::bigint)', async () => {
    state.rows = [
      {
        currency: 'USD',
        charge: '100',
        wholesale: '80',
        user_cashback: '15',
        loop_margin: '5',
        order_count: 42n,
      },
    ];
    const res = await adminSupplierMarginHandler(makeCtx());
    const body = (await res.json()) as { rows: Array<{ orderCount: number }> };
    expect(body.rows[0]!.orderCount).toBe(42);
  });

  it('tolerates { rows } envelope from pg driver', async () => {
    state.rows = {
      rows: [
        {
          currency: null,
          charge: '100',
          wholesale: '80',
          user_cashback: '15',
          loop_margin: '5',
          order_count: 1,
        },
      ],
    };
    const res = await adminSupplierMarginHandler(makeCtx());
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(1);
  });

  it('500 when the aggregate throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminSupplierMarginHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
