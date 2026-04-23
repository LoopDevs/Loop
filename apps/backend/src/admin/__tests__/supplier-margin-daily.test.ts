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

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminSupplierMarginDailyHandler } from '../supplier-margin-daily.js';

function makeCtx(query: Record<string, string> = {}): Context {
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
});

describe('adminSupplierMarginDailyHandler', () => {
  it('returns empty rows when no fulfilled orders in the window', async () => {
    state.rows = [
      {
        day: '2026-04-15',
        currency: null,
        charge: '0',
        wholesale: '0',
        user_cashback: '0',
        loop_margin: '0',
        order_count: 0,
      },
    ];
    const res = await adminSupplierMarginDailyHandler(makeCtx());
    const body = (await res.json()) as { days: number; rows: unknown[] };
    expect(body.days).toBe(30);
    expect(body.rows).toEqual([]);
  });

  it('strips null-currency rows and computes marginBps per (day, currency)', async () => {
    state.rows = [
      {
        day: '2026-04-15',
        currency: null,
        charge: '0',
        wholesale: '0',
        user_cashback: '0',
        loop_margin: '0',
        order_count: 0,
      },
      {
        day: '2026-04-15',
        currency: 'USD',
        charge: '10000',
        wholesale: '8000',
        user_cashback: '1500',
        loop_margin: '500',
        order_count: 2,
      },
      {
        day: '2026-04-16',
        currency: 'USD',
        charge: '20000',
        wholesale: '16000',
        user_cashback: '3000',
        loop_margin: '1000',
        order_count: 4,
      },
    ];
    const res = await adminSupplierMarginDailyHandler(makeCtx());
    const body = (await res.json()) as {
      rows: Array<{
        day: string;
        currency: string;
        chargeMinor: string;
        loopMarginMinor: string;
        orderCount: number;
        marginBps: number;
      }>;
    };
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toEqual({
      day: '2026-04-15',
      currency: 'USD',
      chargeMinor: '10000',
      wholesaleMinor: '8000',
      userCashbackMinor: '1500',
      loopMarginMinor: '500',
      orderCount: 2,
      marginBps: 500, // 500/10000 × 10000 = 500 bps
    });
    expect(body.rows[1]!.marginBps).toBe(500);
  });

  it('clamps ?days to 1..180', async () => {
    const over = await adminSupplierMarginDailyHandler(makeCtx({ days: '900' }));
    expect(((await over.json()) as { days: number }).days).toBe(180);

    const under = await adminSupplierMarginDailyHandler(makeCtx({ days: '0' }));
    expect(((await under.json()) as { days: number }).days).toBe(1);

    const nan = await adminSupplierMarginDailyHandler(makeCtx({ days: 'NaN' }));
    expect(((await nan.json()) as { days: number }).days).toBe(30);
  });

  it('tolerates { rows } envelope from pg driver', async () => {
    state.rows = {
      rows: [
        {
          day: '2026-04-20',
          currency: 'USD',
          charge: '1000',
          wholesale: '800',
          user_cashback: '150',
          loop_margin: '50',
          order_count: 1,
        },
      ],
    };
    const res = await adminSupplierMarginDailyHandler(makeCtx());
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!['marginBps']).toBe(500);
  });

  it('accepts Date objects in the day column', async () => {
    state.rows = [
      {
        day: new Date('2026-04-15T00:00:00Z'),
        currency: 'USD',
        charge: '1000',
        wholesale: '800',
        user_cashback: '150',
        loop_margin: '50',
        order_count: 1,
      },
    ];
    const res = await adminSupplierMarginDailyHandler(makeCtx());
    const body = (await res.json()) as { rows: Array<{ day: string }> };
    expect(body.rows[0]!.day).toBe('2026-04-15');
  });

  it('500 on DB failure', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminSupplierMarginDailyHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
