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
    merchantId: 'orders.merchant_id',
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

import { adminMerchantPaymentMethodShareHandler } from '../merchant-payment-method-share.js';

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

describe('adminMerchantPaymentMethodShareHandler', () => {
  it('400 when merchantId is missing', async () => {
    const res = await adminMerchantPaymentMethodShareHandler(makeCtx({}));
    expect(res.status).toBe(400);
  });

  it('400 when merchantId has disallowed characters', async () => {
    const res = await adminMerchantPaymentMethodShareHandler(makeCtx({ merchantId: 'bad slug' }));
    expect(res.status).toBe(400);
  });

  it('400 when merchantId exceeds 128 chars', async () => {
    const res = await adminMerchantPaymentMethodShareHandler(
      makeCtx({ merchantId: 'x'.repeat(200) }),
    );
    expect(res.status).toBe(400);
  });

  it('400 on invalid ?state', async () => {
    const res = await adminMerchantPaymentMethodShareHandler(
      makeCtx({ merchantId: 'amazon_us' }, { state: 'banana' }),
    );
    expect(res.status).toBe(400);
  });

  it('defaults to state=fulfilled and zero-fills every method on empty result', async () => {
    state.rows = [];
    const res = await adminMerchantPaymentMethodShareHandler(makeCtx({ merchantId: 'amazon_us' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      merchantId: string;
      state: string;
      totalOrders: number;
      byMethod: Record<string, { orderCount: number; chargeMinor: string }>;
    };
    expect(body.merchantId).toBe('amazon_us');
    expect(body.state).toBe('fulfilled');
    expect(body.totalOrders).toBe(0);
    // All four methods zero-filled.
    expect(body.byMethod).toEqual({
      xlm: { orderCount: 0, chargeMinor: '0' },
      usdc: { orderCount: 0, chargeMinor: '0' },
      credit: { orderCount: 0, chargeMinor: '0' },
      loop_asset: { orderCount: 0, chargeMinor: '0' },
    });
  });

  it('honours a valid ?state override', async () => {
    state.rows = [];
    const res = await adminMerchantPaymentMethodShareHandler(
      makeCtx({ merchantId: 'amazon_us' }, { state: 'paid' }),
    );
    const body = (await res.json()) as { state: string };
    expect(body.state).toBe('paid');
  });

  it('maps rows into the byMethod record and totals across buckets', async () => {
    state.rows = [
      { payment_method: 'xlm', order_count: 30n, charge_minor: 12000n },
      { payment_method: 'usdc', order_count: 10, charge_minor: 4000 },
      { payment_method: 'loop_asset', order_count: '5', charge_minor: '2500' },
    ];
    const res = await adminMerchantPaymentMethodShareHandler(makeCtx({ merchantId: 'amazon_us' }));
    const body = (await res.json()) as {
      totalOrders: number;
      byMethod: Record<string, { orderCount: number; chargeMinor: string }>;
    };
    expect(body.totalOrders).toBe(45);
    expect(body.byMethod.xlm).toEqual({ orderCount: 30, chargeMinor: '12000' });
    expect(body.byMethod.usdc).toEqual({ orderCount: 10, chargeMinor: '4000' });
    expect(body.byMethod.loop_asset).toEqual({ orderCount: 5, chargeMinor: '2500' });
    // Unfilled method still zero.
    expect(body.byMethod.credit).toEqual({ orderCount: 0, chargeMinor: '0' });
  });

  it('handles the { rows } envelope shape', async () => {
    state.rows = {
      rows: [{ payment_method: 'xlm', order_count: 3n, charge_minor: 300n }],
    };
    const res = await adminMerchantPaymentMethodShareHandler(makeCtx({ merchantId: 'amazon_us' }));
    const body = (await res.json()) as { totalOrders: number };
    expect(body.totalOrders).toBe(3);
  });

  it('drops unknown payment_method values with a log-warn (no crash)', async () => {
    state.rows = [
      { payment_method: 'xlm', order_count: 2n, charge_minor: 200n },
      { payment_method: 'wire_transfer', order_count: 9n, charge_minor: 9999n },
    ];
    const res = await adminMerchantPaymentMethodShareHandler(makeCtx({ merchantId: 'amazon_us' }));
    const body = (await res.json()) as {
      totalOrders: number;
      byMethod: Record<string, { orderCount: number; chargeMinor: string }>;
    };
    expect(body.totalOrders).toBe(2);
    expect(body.byMethod.xlm?.orderCount).toBe(2);
    // Unknown method dropped entirely.
    expect((body.byMethod as Record<string, unknown>).wire_transfer).toBeUndefined();
  });

  it('500 when the db throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminMerchantPaymentMethodShareHandler(makeCtx({ merchantId: 'amazon_us' }));
    expect(res.status).toBe(500);
  });
});
