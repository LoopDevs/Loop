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
    userId: 'orders.user_id',
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

import { adminUserPaymentMethodShareHandler } from '../user-payment-method-share.js';

const VALID_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeCtx(
  params: Record<string, string | undefined> = {},
  query: Record<string, string | undefined> = {},
): Context {
  return {
    req: {
      query: (k: string) => query[k],
      param: (k: string) => params[k],
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

describe('adminUserPaymentMethodShareHandler', () => {
  it('400 when userId is missing', async () => {
    const res = await adminUserPaymentMethodShareHandler(makeCtx({}));
    expect(res.status).toBe(400);
  });

  it('400 when userId is not a uuid', async () => {
    const res = await adminUserPaymentMethodShareHandler(makeCtx({ userId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
  });

  it('400 on invalid ?state', async () => {
    const res = await adminUserPaymentMethodShareHandler(
      makeCtx({ userId: VALID_UUID }, { state: 'banana' }),
    );
    expect(res.status).toBe(400);
  });

  it('defaults to state=fulfilled and zero-fills every method on empty result', async () => {
    state.rows = [];
    const res = await adminUserPaymentMethodShareHandler(makeCtx({ userId: VALID_UUID }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      userId: string;
      state: string;
      totalOrders: number;
      byMethod: Record<string, { orderCount: number; chargeMinor: string }>;
    };
    expect(body.userId).toBe(VALID_UUID);
    expect(body.state).toBe('fulfilled');
    expect(body.totalOrders).toBe(0);
    expect(body.byMethod).toEqual({
      xlm: { orderCount: 0, chargeMinor: '0' },
      usdc: { orderCount: 0, chargeMinor: '0' },
      credit: { orderCount: 0, chargeMinor: '0' },
      loop_asset: { orderCount: 0, chargeMinor: '0' },
    });
  });

  it('honours a valid ?state override', async () => {
    state.rows = [];
    const res = await adminUserPaymentMethodShareHandler(
      makeCtx({ userId: VALID_UUID }, { state: 'paid' }),
    );
    const body = (await res.json()) as { state: string };
    expect(body.state).toBe('paid');
  });

  it('maps rows into byMethod and totals across buckets', async () => {
    state.rows = [
      { payment_method: 'xlm', order_count: 8n, charge_minor: 3200n },
      { payment_method: 'loop_asset', order_count: 4, charge_minor: 1600 },
    ];
    const res = await adminUserPaymentMethodShareHandler(makeCtx({ userId: VALID_UUID }));
    const body = (await res.json()) as {
      totalOrders: number;
      byMethod: Record<string, { orderCount: number; chargeMinor: string }>;
    };
    expect(body.totalOrders).toBe(12);
    expect(body.byMethod.xlm).toEqual({ orderCount: 8, chargeMinor: '3200' });
    expect(body.byMethod.loop_asset).toEqual({ orderCount: 4, chargeMinor: '1600' });
    // Unfilled methods still zero.
    expect(body.byMethod.usdc).toEqual({ orderCount: 0, chargeMinor: '0' });
    expect(body.byMethod.credit).toEqual({ orderCount: 0, chargeMinor: '0' });
  });

  it('handles the { rows } envelope shape', async () => {
    state.rows = {
      rows: [{ payment_method: 'xlm', order_count: 2n, charge_minor: 200n }],
    };
    const res = await adminUserPaymentMethodShareHandler(makeCtx({ userId: VALID_UUID }));
    const body = (await res.json()) as { totalOrders: number };
    expect(body.totalOrders).toBe(2);
  });

  it('drops unknown payment_method values with a log-warn', async () => {
    state.rows = [
      { payment_method: 'loop_asset', order_count: 3n, charge_minor: 1500n },
      { payment_method: 'wire_transfer', order_count: 9n, charge_minor: 9999n },
    ];
    const res = await adminUserPaymentMethodShareHandler(makeCtx({ userId: VALID_UUID }));
    const body = (await res.json()) as {
      totalOrders: number;
      byMethod: Record<string, { orderCount: number; chargeMinor: string }>;
    };
    expect(body.totalOrders).toBe(3);
    expect(body.byMethod.loop_asset?.orderCount).toBe(3);
    expect((body.byMethod as Record<string, unknown>).wire_transfer).toBeUndefined();
  });

  it('500 when the db throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminUserPaymentMethodShareHandler(makeCtx({ userId: VALID_UUID }));
    expect(res.status).toBe(500);
  });
});
