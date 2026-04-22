import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

/**
 * DB mock: the handler runs a single `db.execute(sql\`...\`)`. Tests
 * push (day, payment_method, count) triples into `state.result`;
 * the handler pivots them into per-day buckets.
 */
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
    state: 'state',
    fulfilledAt: 'fulfilled_at',
    paymentMethod: 'payment_method',
  },
}));

import { adminPaymentMethodActivityHandler } from '../payment-method-activity.js';

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

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

beforeEach(() => {
  state.result = [];
  state.throw = false;
});

describe('adminPaymentMethodActivityHandler', () => {
  it('default windowDays=30; seeds every day with a zero bucket', async () => {
    state.result = [];
    const res = await adminPaymentMethodActivityHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      days: Array<{ day: string; byMethod: Record<string, number> }>;
      windowDays: number;
    };
    expect(body.windowDays).toBe(30);
    expect(body.days).toHaveLength(30);
    // Every day has all four rails present, zero-valued.
    for (const d of body.days) {
      expect(d.byMethod).toEqual({ xlm: 0, usdc: 0, credit: 0, loop_asset: 0 });
    }
    // Oldest-first ordering: days[0] is the earliest key.
    const sorted = [...body.days].sort((a, b) => a.day.localeCompare(b.day));
    expect(body.days).toEqual(sorted);
  });

  it('clamps windowDays — floor 1, cap 90, malformed falls back to 30', async () => {
    const r0 = await adminPaymentMethodActivityHandler(makeCtx({ days: '-5' }));
    expect(((await r0.json()) as { windowDays: number }).windowDays).toBe(1);

    const r1 = await adminPaymentMethodActivityHandler(makeCtx({ days: '9999' }));
    expect(((await r1.json()) as { windowDays: number }).windowDays).toBe(90);

    const r2 = await adminPaymentMethodActivityHandler(makeCtx({ days: 'nope' }));
    expect(((await r2.json()) as { windowDays: number }).windowDays).toBe(30);
  });

  it('pivots db rows into per-day buckets and preserves counts', async () => {
    const todayKey = ymd(new Date());
    state.result = [
      { day: todayKey, payment_method: 'loop_asset', c: '12' },
      { day: todayKey, payment_method: 'xlm', c: '3' },
      { day: todayKey, payment_method: 'credit', c: '1' },
    ];
    const res = await adminPaymentMethodActivityHandler(makeCtx({ days: '7' }));
    const body = (await res.json()) as {
      days: Array<{ day: string; byMethod: Record<string, number> }>;
    };
    const todayBucket = body.days.find((d) => d.day === todayKey);
    expect(todayBucket).toBeDefined();
    expect(todayBucket?.byMethod).toEqual({
      xlm: 3,
      usdc: 0,
      credit: 1,
      loop_asset: 12,
    });
  });

  it('drops unknown payment_method values defensively (log-warn path)', async () => {
    const todayKey = ymd(new Date());
    state.result = [
      { day: todayKey, payment_method: 'bitcoin', c: '99' },
      { day: todayKey, payment_method: 'loop_asset', c: '5' },
    ];
    const res = await adminPaymentMethodActivityHandler(makeCtx({ days: '7' }));
    const body = (await res.json()) as {
      days: Array<{ day: string; byMethod: Record<string, number> }>;
    };
    const todayBucket = body.days.find((d) => d.day === todayKey);
    expect(todayBucket?.byMethod).toEqual({
      xlm: 0,
      usdc: 0,
      credit: 0,
      loop_asset: 5, // unknown bitcoin row dropped; loop_asset still counted
    });
  });

  it('ignores out-of-window db rows (day not in seeded range)', async () => {
    state.result = [{ day: '2020-01-01', payment_method: 'loop_asset', c: '100' }];
    const res = await adminPaymentMethodActivityHandler(makeCtx({ days: '7' }));
    const body = (await res.json()) as {
      days: Array<{ day: string; byMethod: Record<string, number> }>;
    };
    // Every returned day should have all-zero counts — the stale row
    // was dropped rather than added to the first seeded bucket.
    for (const d of body.days) {
      expect(d.byMethod).toEqual({ xlm: 0, usdc: 0, credit: 0, loop_asset: 0 });
    }
  });

  it('500 when the db throws', async () => {
    state.throw = true;
    const res = await adminPaymentMethodActivityHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
