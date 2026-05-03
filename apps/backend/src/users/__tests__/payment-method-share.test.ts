import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import type { LoopAuthContext } from '../../auth/handler.js';

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
    userId: 'orders.user_id',
    state: 'orders.state',
    paymentMethod: 'orders.payment_method',
    chargeMinor: 'orders.charge_minor',
    chargeCurrency: 'orders.charge_currency',
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

const { userState } = vi.hoisted(() => ({
  userState: {
    byId: null as unknown,
  },
}));

vi.mock('../../db/users.js', () => ({
  getUserById: vi.fn(async () => userState.byId),
  upsertUserFromCtx: vi.fn(async () => userState.byId),
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { getUserPaymentMethodShareHandler } from '../payment-method-share.js';

const LOOP_AUTH: LoopAuthContext = {
  kind: 'loop',
  userId: 'u-1',
  email: 'u-1@example.com',
  bearerToken: 'stub-bearer',
};

function makeCtx(
  auth: LoopAuthContext | undefined,
  query: Record<string, string | undefined> = {},
): Context {
  return {
    req: {
      query: (k: string) => query[k],
    },
    get: (k: string) => (k === 'auth' ? auth : undefined),
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
  userState.byId = { id: 'u-1', homeCurrency: 'GBP' };
});

describe('getUserPaymentMethodShareHandler', () => {
  it('401 when no auth context', async () => {
    const res = await getUserPaymentMethodShareHandler(makeCtx(undefined));
    expect(res.status).toBe(401);
  });

  it('400 on invalid ?state', async () => {
    const res = await getUserPaymentMethodShareHandler(makeCtx(LOOP_AUTH, { state: 'banana' }));
    expect(res.status).toBe(400);
  });

  it('defaults to state=fulfilled and zero-fills every method on empty result', async () => {
    state.rows = [];
    const res = await getUserPaymentMethodShareHandler(makeCtx(LOOP_AUTH));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      currency: string;
      state: string;
      totalOrders: number;
      byMethod: Record<string, { orderCount: number; chargeMinor: string }>;
    };
    expect(body.currency).toBe('GBP');
    expect(body.state).toBe('fulfilled');
    expect(body.totalOrders).toBe(0);
    expect(body.byMethod).toEqual({
      xlm: { orderCount: 0, chargeMinor: '0' },
      usdc: { orderCount: 0, chargeMinor: '0' },
      credit: { orderCount: 0, chargeMinor: '0' },
      loop_asset: { orderCount: 0, chargeMinor: '0' },
    });
  });

  it('maps rows into byMethod and totals across buckets', async () => {
    state.rows = [
      { payment_method: 'xlm', order_count: 7n, charge_minor: 3500n },
      { payment_method: 'loop_asset', order_count: 3, charge_minor: 1500 },
    ];
    const res = await getUserPaymentMethodShareHandler(makeCtx(LOOP_AUTH));
    const body = (await res.json()) as {
      totalOrders: number;
      byMethod: Record<string, { orderCount: number; chargeMinor: string }>;
    };
    expect(body.totalOrders).toBe(10);
    expect(body.byMethod.xlm).toEqual({ orderCount: 7, chargeMinor: '3500' });
    expect(body.byMethod.loop_asset).toEqual({ orderCount: 3, chargeMinor: '1500' });
    expect(body.byMethod.usdc).toEqual({ orderCount: 0, chargeMinor: '0' });
  });

  it('honours a valid ?state override', async () => {
    state.rows = [];
    const res = await getUserPaymentMethodShareHandler(makeCtx(LOOP_AUTH, { state: 'paid' }));
    const body = (await res.json()) as { state: string };
    expect(body.state).toBe('paid');
  });

  it('drops unknown payment_method values with a log-warn', async () => {
    state.rows = [
      { payment_method: 'xlm', order_count: 2n, charge_minor: 200n },
      { payment_method: 'wire_transfer', order_count: 9n, charge_minor: 9999n },
    ];
    const res = await getUserPaymentMethodShareHandler(makeCtx(LOOP_AUTH));
    const body = (await res.json()) as {
      totalOrders: number;
      byMethod: Record<string, { orderCount: number; chargeMinor: string }>;
    };
    expect(body.totalOrders).toBe(2);
    expect(body.byMethod.xlm?.orderCount).toBe(2);
    expect((body.byMethod as Record<string, unknown>).wire_transfer).toBeUndefined();
  });

  it('handles the { rows } envelope shape', async () => {
    state.rows = {
      rows: [{ payment_method: 'loop_asset', order_count: 1n, charge_minor: 100n }],
    };
    const res = await getUserPaymentMethodShareHandler(makeCtx(LOOP_AUTH));
    const body = (await res.json()) as { totalOrders: number };
    expect(body.totalOrders).toBe(1);
  });

  it('500 when the db throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await getUserPaymentMethodShareHandler(makeCtx(LOOP_AUTH));
    expect(res.status).toBe(500);
  });
});
