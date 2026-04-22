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

import { adminPayoutsActivityCsvHandler } from '../payouts-activity-csv.js';

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

describe('adminPayoutsActivityCsvHandler', () => {
  it('returns just the header row when the DB returns nothing', async () => {
    const res = await adminPayoutsActivityCsvHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="payouts-activity-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const body = await res.text();
    expect(body.startsWith('day,asset_code,payout_count,stroops')).toBe(true);
    expect(body.split('\r\n').filter((l) => l.length > 0)).toHaveLength(1);
  });

  it('emits one row per (day, asset_code) with bigint + date coercion', async () => {
    state.rows = [
      {
        day: '2026-04-20',
        asset_code: 'USDLOOP',
        count: 3n,
        stroops: 50_000_000n,
      },
      {
        day: new Date('2026-04-21T00:00:00Z'),
        asset_code: 'GBPLOOP',
        count: 1,
        stroops: '12000000',
      },
    ];
    const res = await adminPayoutsActivityCsvHandler(makeCtx());
    const body = await res.text();
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    expect(lines).toEqual([
      'day,asset_code,payout_count,stroops',
      '2026-04-20,USDLOOP,3,50000000',
      '2026-04-21,GBPLOOP,1,12000000',
    ]);
  });

  it('emits empty asset_code + 0,0 on zero-activity LEFT-JOIN days', async () => {
    state.rows = [
      { day: '2026-04-20', asset_code: null, count: 0n, stroops: 0n },
      { day: '2026-04-21', asset_code: 'USDLOOP', count: 1n, stroops: 100n },
    ];
    const res = await adminPayoutsActivityCsvHandler(makeCtx());
    const body = await res.text();
    expect(body).toMatch(/\r\n2026-04-20,,0,0\r\n/);
    expect(body).toMatch(/\r\n2026-04-21,USDLOOP,1,100\r\n/);
  });

  it('preserves bigint precision past 2^53', async () => {
    state.rows = [
      {
        day: '2026-04-22',
        asset_code: 'USDLOOP',
        count: 1n,
        stroops: 9007199254740992n + 31n,
      },
    ];
    const res = await adminPayoutsActivityCsvHandler(makeCtx());
    const body = await res.text();
    expect(body).toMatch(/9007199254741023/);
  });

  it('defaults to 31 days and clamps to [1, 366]', async () => {
    // No crash paths — just make sure the handler returns 200 for
    // common inputs. The SQL is mocked so we can't observe the
    // actual `days` used, but the query path must not throw.
    state.rows = [];
    for (const days of ['1', '31', '500', '-10', 'nonsense', undefined]) {
      const res = await adminPayoutsActivityCsvHandler(makeCtx(days === undefined ? {} : { days }));
      expect(res.status).toBe(200);
    }
  });

  it('appends __TRUNCATED__ sentinel when the row cap is exceeded', async () => {
    // Simulate 10_001 rows (cap + 1). Each row is valid; the
    // handler slices to 10_000 and emits __TRUNCATED__.
    state.rows = Array.from({ length: 10_001 }, (_, i) => ({
      day: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      asset_code: 'USDLOOP',
      count: 1n,
      stroops: 1n,
    }));
    const res = await adminPayoutsActivityCsvHandler(makeCtx());
    const body = await res.text();
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    // 1 header + 10_000 rows + 1 sentinel = 10_002 lines.
    expect(lines).toHaveLength(10_002);
    expect(lines.at(-1)).toBe('__TRUNCATED__');
  });

  it('500 when the db throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminPayoutsActivityCsvHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
