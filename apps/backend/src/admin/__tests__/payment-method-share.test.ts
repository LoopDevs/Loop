import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { execState } = vi.hoisted(() => ({
  execState: { rows: [] as unknown[] | { rows: unknown[] }, throw: false },
}));
vi.mock('../../db/client.js', () => ({
  db: {
    execute: vi.fn(async () => {
      if (execState.throw) throw new Error('db exploded');
      return execState.rows;
    }),
  },
}));
vi.mock('../../db/schema.js', () => ({
  ORDER_PAYMENT_METHODS: ['xlm', 'usdc', 'credit', 'loop_asset'] as const,
  ORDER_STATES: ['pending_payment', 'paid', 'procuring', 'fulfilled', 'failed', 'expired'] as const,
  orders: {
    paymentMethod: 'payment_method',
    state: 'state',
    chargeMinor: 'charge_minor',
  },
}));

import { adminPaymentMethodShareHandler } from '../payment-method-share.js';

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
  execState.rows = [];
  execState.throw = false;
});

describe('adminPaymentMethodShareHandler', () => {
  it('happy path — zero-fills + sums totals + defaults state to fulfilled', async () => {
    execState.rows = [
      { paymentMethod: 'loop_asset', n: 390, chargeSum: 390000n },
      { paymentMethod: 'xlm', n: 50, chargeSum: 50000n },
      { paymentMethod: 'credit', n: 8, chargeSum: 8000n },
    ];
    const res = await adminPaymentMethodShareHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: string;
      totalOrders: number;
      byMethod: Record<string, { orderCount: number; chargeMinor: string }>;
    };
    expect(body.state).toBe('fulfilled');
    expect(body.totalOrders).toBe(448);
    expect(body.byMethod.loop_asset).toEqual({ orderCount: 390, chargeMinor: '390000' });
    expect(body.byMethod.xlm).toEqual({ orderCount: 50, chargeMinor: '50000' });
    // usdc had zero rows — zero-filled.
    expect(body.byMethod.usdc).toEqual({ orderCount: 0, chargeMinor: '0' });
  });

  it('accepts a valid non-default ?state filter', async () => {
    execState.rows = [{ paymentMethod: 'xlm', n: 2, chargeSum: 2000n }];
    const res = await adminPaymentMethodShareHandler(makeCtx({ state: 'paid' }));
    const body = (await res.json()) as { state: string; byMethod: Record<string, unknown> };
    expect(body.state).toBe('paid');
  });

  it('rejects an unknown ?state with 400', async () => {
    const res = await adminPaymentMethodShareHandler(makeCtx({ state: 'bogus' }));
    expect(res.status).toBe(400);
  });

  it('ignores unknown payment_method values the driver might return', async () => {
    execState.rows = [
      { paymentMethod: 'unexpected', n: 99, chargeSum: 100n },
      { paymentMethod: 'xlm', n: 1, chargeSum: 10n },
    ];
    const res = await adminPaymentMethodShareHandler(makeCtx());
    const body = (await res.json()) as {
      totalOrders: number;
      byMethod: Record<string, { orderCount: number }>;
    };
    expect(body.totalOrders).toBe(1);
    expect(body.byMethod.xlm?.orderCount).toBe(1);
  });

  it('returns zero-filled shape when no rows match', async () => {
    execState.rows = [];
    const res = await adminPaymentMethodShareHandler(makeCtx());
    const body = (await res.json()) as {
      totalOrders: number;
      byMethod: Record<string, { orderCount: number }>;
    };
    expect(body.totalOrders).toBe(0);
    expect(body.byMethod.xlm?.orderCount).toBe(0);
    expect(body.byMethod.usdc?.orderCount).toBe(0);
    expect(body.byMethod.credit?.orderCount).toBe(0);
    expect(body.byMethod.loop_asset?.orderCount).toBe(0);
  });

  it('handles the {rows: [...]} drizzle result shape', async () => {
    execState.rows = {
      rows: [{ paymentMethod: 'usdc', n: 3, chargeSum: 300n }],
    };
    const res = await adminPaymentMethodShareHandler(makeCtx());
    const body = (await res.json()) as { byMethod: Record<string, { orderCount: number }> };
    expect(body.byMethod.usdc?.orderCount).toBe(3);
  });

  it('500 when the db read throws', async () => {
    execState.throw = true;
    const res = await adminPaymentMethodShareHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
