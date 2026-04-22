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
    state: 'orders.state',
    paymentMethod: 'orders.payment_method',
    chargeMinor: 'orders.charge_minor',
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

import { adminPaymentMethodShareHandler } from '../payment-method-share.js';

function makeCtx(query: Record<string, string | undefined> = {}): Context {
  return {
    req: {
      query: (k: string) => query[k],
      param: (_k: string) => undefined,
    },
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

describe('adminPaymentMethodShareHandler', () => {
  it('defaults to state=fulfilled with zero-fill on empty result', async () => {
    state.rows = [];
    const res = await adminPaymentMethodShareHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: string;
      totalOrders: number;
      byMethod: Record<string, { orderCount: number; chargeMinor: string }>;
    };
    expect(body.state).toBe('fulfilled');
    expect(body.totalOrders).toBe(0);
    // All four methods zero-filled with canonical shapes.
    expect(body.byMethod['xlm']).toEqual({ orderCount: 0, chargeMinor: '0' });
    expect(body.byMethod['usdc']).toEqual({ orderCount: 0, chargeMinor: '0' });
    expect(body.byMethod['credit']).toEqual({ orderCount: 0, chargeMinor: '0' });
    expect(body.byMethod['loop_asset']).toEqual({ orderCount: 0, chargeMinor: '0' });
  });

  it('builds byMethod from the aggregate rows and sums totalOrders', async () => {
    state.rows = [
      { payment_method: 'xlm', order_count: 50n, charge_minor: 50_000n },
      { payment_method: 'credit', order_count: 8n, charge_minor: 8_000n },
      { payment_method: 'loop_asset', order_count: 390n, charge_minor: 390_000n },
    ];
    const res = await adminPaymentMethodShareHandler(makeCtx());
    const body = (await res.json()) as {
      totalOrders: number;
      byMethod: Record<string, { orderCount: number; chargeMinor: string }>;
    };
    expect(body.totalOrders).toBe(448);
    expect(body.byMethod['xlm']).toEqual({ orderCount: 50, chargeMinor: '50000' });
    expect(body.byMethod['loop_asset']).toEqual({
      orderCount: 390,
      chargeMinor: '390000',
    });
    // usdc had no rows — still present, still zeroed.
    expect(body.byMethod['usdc']).toEqual({ orderCount: 0, chargeMinor: '0' });
  });

  it('accepts any valid state via ?state=', async () => {
    state.rows = [];
    const res = await adminPaymentMethodShareHandler(makeCtx({ state: 'failed' }));
    const body = (await res.json()) as { state: string };
    expect(body.state).toBe('failed');
  });

  it('400 on unknown state', async () => {
    const res = await adminPaymentMethodShareHandler(makeCtx({ state: 'nonsense' }));
    expect(res.status).toBe(400);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('silently drops unknown payment_method values from the aggregate', async () => {
    state.rows = [
      { payment_method: 'xlm', order_count: 10n, charge_minor: 100n },
      { payment_method: 'future_rail', order_count: 99n, charge_minor: 9_999n },
    ];
    const res = await adminPaymentMethodShareHandler(makeCtx());
    const body = (await res.json()) as {
      totalOrders: number;
      byMethod: Record<string, { orderCount: number }>;
    };
    // Only the known 'xlm' row counts toward the total; future_rail
    // isn't in the enum so it's dropped with a log-warn.
    expect(body.totalOrders).toBe(10);
    expect(body.byMethod['xlm']?.orderCount).toBe(10);
  });

  it('handles postgres-js { rows: [...] } return shape', async () => {
    executeMock.mockImplementationOnce(async () => ({
      rows: [{ payment_method: 'loop_asset', order_count: 1n, charge_minor: 500n }],
    }));
    const res = await adminPaymentMethodShareHandler(makeCtx());
    const body = (await res.json()) as {
      byMethod: Record<string, { orderCount: number; chargeMinor: string }>;
    };
    expect(body.byMethod['loop_asset']).toEqual({ orderCount: 1, chargeMinor: '500' });
  });

  it('500 when the query throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminPaymentMethodShareHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
