import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
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

import { adminCashbackActivityHandler } from '../cashback-activity.js';

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

describe('adminCashbackActivityHandler', () => {
  it('returns an empty rows array when the DB returns nothing', async () => {
    const res = await adminCashbackActivityHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: number; rows: unknown[] };
    expect(body.days).toBe(30);
    expect(body.rows).toEqual([]);
  });

  it('pivots (day,currency) rows into { day, count, byCurrency[] }', async () => {
    state.rows = [
      // Day 1: two currencies.
      { day: '2026-04-20', currency: 'GBP', count: '3', amount_minor: 4500n },
      { day: '2026-04-20', currency: 'USD', count: 2, amount_minor: '2000' },
      // Day 2: one currency.
      { day: '2026-04-21', currency: 'EUR', count: '1', amount_minor: 900n },
    ];
    const res = await adminCashbackActivityHandler(makeCtx());
    const body = (await res.json()) as {
      rows: Array<{ day: string; count: number; byCurrency: unknown[] }>;
    };
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]!.day).toBe('2026-04-20');
    expect(body.rows[0]!.count).toBe(5);
    expect(body.rows[0]!.byCurrency).toEqual([
      { currency: 'GBP', amountMinor: '4500' },
      { currency: 'USD', amountMinor: '2000' },
    ]);
    expect(body.rows[1]!.day).toBe('2026-04-21');
    expect(body.rows[1]!.count).toBe(1);
    expect(body.rows[1]!.byCurrency).toEqual([{ currency: 'EUR', amountMinor: '900' }]);
  });

  it('keeps zero-activity days with empty byCurrency arrays', async () => {
    state.rows = [
      { day: '2026-04-20', currency: null, count: '0', amount_minor: 0n },
      { day: '2026-04-21', currency: 'GBP', count: '2', amount_minor: 200n },
      { day: '2026-04-22', currency: null, count: '0', amount_minor: 0n },
    ];
    const res = await adminCashbackActivityHandler(makeCtx());
    const body = (await res.json()) as {
      rows: Array<{ day: string; count: number; byCurrency: unknown[] }>;
    };
    expect(body.rows).toHaveLength(3);
    expect(body.rows[0]).toEqual({ day: '2026-04-20', count: 0, byCurrency: [] });
    expect(body.rows[1]!.count).toBe(2);
    expect(body.rows[2]).toEqual({ day: '2026-04-22', count: 0, byCurrency: [] });
  });

  it('clamps days — huge values cap at 180, bad values fall back to 30, 0 → 1', async () => {
    const resHuge = await adminCashbackActivityHandler(makeCtx({ days: '9999' }));
    expect(((await resHuge.json()) as { days: number }).days).toBe(180);

    const resBad = await adminCashbackActivityHandler(makeCtx({ days: 'nope' }));
    expect(((await resBad.json()) as { days: number }).days).toBe(30);

    const resZero = await adminCashbackActivityHandler(makeCtx({ days: '0' }));
    expect(((await resZero.json()) as { days: number }).days).toBe(1);
  });

  it('handles Date-typed day values from the DB driver', async () => {
    state.rows = [
      {
        day: new Date('2026-04-20T00:00:00Z'),
        currency: 'GBP',
        count: '1',
        amount_minor: 100n,
      },
    ];
    const res = await adminCashbackActivityHandler(makeCtx());
    const body = (await res.json()) as {
      rows: Array<{ day: string }>;
    };
    expect(body.rows[0]!.day).toBe('2026-04-20');
  });

  it('500 when the repo throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminCashbackActivityHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
