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

import { adminCashbackActivityCsvHandler } from '../cashback-activity-csv.js';

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

describe('adminCashbackActivityCsvHandler', () => {
  it('returns just the header row when the DB returns nothing', async () => {
    const res = await adminCashbackActivityCsvHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="cashback-activity-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const body = await res.text();
    expect(body.startsWith('day,currency,cashback_count,cashback_minor')).toBe(true);
    expect(body.split('\r\n').filter((l) => l.length > 0)).toHaveLength(1);
  });

  it('emits one row per (day, currency) with bigint + date coercion', async () => {
    state.rows = [
      {
        day: '2026-04-20',
        currency: 'GBP',
        count: 3n,
        amount_minor: 42_000n,
      },
      {
        day: new Date('2026-04-21T00:00:00Z'),
        currency: 'USD',
        count: 2,
        amount_minor: '18000',
      },
      {
        day: '2026-04-22',
        currency: null,
        count: '0',
        amount_minor: 0n,
      },
    ];
    const res = await adminCashbackActivityCsvHandler(makeCtx());
    const body = await res.text();
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('2026-04-20,GBP,3,42000');
    expect(lines[2]).toBe('2026-04-21,USD,2,18000');
    // Zero-activity day emits empty currency + 0 / 0.
    expect(lines[3]).toBe('2026-04-22,,0,0');
  });

  it('clamps ?days — huge values cap at 366, malformed falls back to default', async () => {
    // Doesn't error, just clamps. Shape assertion: handler responds
    // 200 on each so the caller can recover from a typo without a
    // 400 round-trip.
    const resHuge = await adminCashbackActivityCsvHandler(makeCtx({ days: '9999' }));
    expect(resHuge.status).toBe(200);
    const resZero = await adminCashbackActivityCsvHandler(makeCtx({ days: '0' }));
    expect(resZero.status).toBe(200);
    const resBad = await adminCashbackActivityCsvHandler(makeCtx({ days: 'not-a-number' }));
    expect(resBad.status).toBe(200);
  });

  it('truncates with __TRUNCATED__ sentinel past 10 000 rows', async () => {
    state.rows = Array.from({ length: 10_001 }, (_, i) => ({
      day: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      currency: 'GBP',
      count: 1n,
      amount_minor: 100n,
    }));
    const res = await adminCashbackActivityCsvHandler(makeCtx());
    const body = await res.text();
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(10_002);
    expect(lines[lines.length - 1]).toBe('__TRUNCATED__');
  });

  it('tolerates the { rows } envelope node-postgres returns', async () => {
    state.rows = {
      rows: [
        {
          day: '2026-04-22',
          currency: 'EUR',
          count: 1n,
          amount_minor: 900n,
        },
      ],
    } as unknown as Array<Record<string, unknown>>;
    const res = await adminCashbackActivityCsvHandler(makeCtx());
    const body = await res.text();
    expect(body).toContain('2026-04-22,EUR,1,900');
  });

  it('500 when the aggregate throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminCashbackActivityCsvHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
