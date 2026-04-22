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
  creditTransactions: {
    id: 'id',
    amountMinor: 'amount_minor',
    currency: 'currency',
    type: 'type',
    createdAt: 'created_at',
  },
}));

import { adminCashbackActivityHandler } from '../cashback-activity.js';

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

describe('adminCashbackActivityHandler', () => {
  it('pivots per-currency rows into a single entry per day, oldest-first', async () => {
    execState.rows = [
      { day: '2026-04-20', currency: 'GBP', cashbackMinor: 300n, events: 2 },
      { day: '2026-04-20', currency: 'USD', cashbackMinor: 120n, events: 1 },
      { day: '2026-04-21', currency: 'GBP', cashbackMinor: 450n, events: 3 },
    ];
    const res = await adminCashbackActivityHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      windowDays: number;
      days: Array<{
        day: string;
        byCurrency: Record<string, { cashbackMinor: string; events: number }>;
      }>;
    };
    expect(body.windowDays).toBe(7);
    expect(body.days).toHaveLength(2);
    expect(body.days[0]?.day).toBe('2026-04-20');
    expect(body.days[0]?.byCurrency).toEqual({
      GBP: { cashbackMinor: '300', events: 2 },
      USD: { cashbackMinor: '120', events: 1 },
    });
    expect(body.days[1]?.byCurrency.GBP).toEqual({ cashbackMinor: '450', events: 3 });
  });

  it('null-currency row (zero-cashback day) yields an empty byCurrency', async () => {
    execState.rows = [{ day: '2026-04-22', currency: null, cashbackMinor: '0', events: 0 }];
    const res = await adminCashbackActivityHandler(makeCtx());
    const body = (await res.json()) as {
      days: Array<{ day: string; byCurrency: Record<string, unknown> }>;
    };
    expect(body.days).toHaveLength(1);
    expect(body.days[0]?.byCurrency).toEqual({});
  });

  it('clamps ?days — huge caps at 90, malformed → 7, zero → 1', async () => {
    execState.rows = [];
    let body = (await (await adminCashbackActivityHandler(makeCtx({ days: '9999' }))).json()) as {
      windowDays: number;
    };
    expect(body.windowDays).toBe(90);
    body = (await (await adminCashbackActivityHandler(makeCtx({ days: 'nope' }))).json()) as {
      windowDays: number;
    };
    expect(body.windowDays).toBe(7);
    body = (await (await adminCashbackActivityHandler(makeCtx({ days: '0' }))).json()) as {
      windowDays: number;
    };
    expect(body.windowDays).toBe(1);
  });

  it('handles Date-typed day values (driver without TO_CHAR)', async () => {
    execState.rows = [
      {
        day: new Date('2026-04-22T00:00:00Z'),
        currency: 'GBP',
        cashbackMinor: 100n,
        events: 1,
      },
    ];
    const res = await adminCashbackActivityHandler(makeCtx());
    const body = (await res.json()) as { days: Array<{ day: string }> };
    expect(body.days[0]?.day).toBe('2026-04-22');
  });

  it('handles the {rows: [...]} drizzle result shape', async () => {
    execState.rows = {
      rows: [{ day: '2026-04-22', currency: 'EUR', cashbackMinor: 50n, events: 1 }],
    };
    const res = await adminCashbackActivityHandler(makeCtx());
    const body = (await res.json()) as {
      days: Array<{ byCurrency: Record<string, unknown> }>;
    };
    expect(body.days[0]?.byCurrency.EUR).toBeDefined();
  });

  it('500 when the db read throws', async () => {
    execState.throw = true;
    const res = await adminCashbackActivityHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
