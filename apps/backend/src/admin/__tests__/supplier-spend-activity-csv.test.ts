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

import { adminSupplierSpendActivityCsvHandler } from '../supplier-spend-activity-csv.js';

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

describe('adminSupplierSpendActivityCsvHandler', () => {
  it('returns just the header row when the DB returns nothing', async () => {
    const res = await adminSupplierSpendActivityCsvHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = await res.text();
    expect(body).toBe(
      'day,currency,count,face_value_minor,wholesale_minor,user_cashback_minor,loop_margin_minor\r\n',
    );
  });

  it('emits a Content-Disposition with a stable .csv filename', async () => {
    const res = await adminSupplierSpendActivityCsvHandler(makeCtx());
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toMatch(/attachment; filename="supplier-spend-activity-\d{4}-\d{2}-\d{2}\.csv"/);
  });

  it('maps bigint/string money columns to their decimal string form', async () => {
    state.rows = [
      {
        day: '2026-04-20',
        currency: 'USD',
        count: 42n,
        face_value_minor: '2500000',
        wholesale_minor: 2400000n,
        user_cashback_minor: 75000,
        loop_margin_minor: '25000',
      },
    ];
    const res = await adminSupplierSpendActivityCsvHandler(makeCtx());
    const body = await res.text();
    expect(body.split('\r\n')[1]).toBe('2026-04-20,USD,42,2500000,2400000,75000,25000');
  });

  it('preserves bigint precision past 2^53 on wholesale sums', async () => {
    state.rows = [
      {
        day: '2026-04-20',
        currency: 'USD',
        count: 1n,
        face_value_minor: '9007199254741045',
        wholesale_minor: 9007199254741045n,
        user_cashback_minor: 0n,
        loop_margin_minor: 0n,
      },
    ];
    const res = await adminSupplierSpendActivityCsvHandler(makeCtx());
    const body = await res.text();
    expect(body).toContain('9007199254741045,9007199254741045,0,0');
  });

  it('emits zero-fill rows for empty days (empty currency, zeros)', async () => {
    state.rows = [
      {
        day: '2026-04-20',
        currency: null,
        count: 0n,
        face_value_minor: 0n,
        wholesale_minor: 0n,
        user_cashback_minor: 0n,
        loop_margin_minor: 0n,
      },
    ];
    const res = await adminSupplierSpendActivityCsvHandler(makeCtx());
    const body = await res.text();
    expect(body.split('\r\n')[1]).toBe('2026-04-20,,0,0,0,0,0');
  });

  it('clamps ?days to [1, 366] and falls back for NaN', async () => {
    const below = await adminSupplierSpendActivityCsvHandler(makeCtx({ days: '0' }));
    expect(below.status).toBe(200);
    const above = await adminSupplierSpendActivityCsvHandler(makeCtx({ days: '9999' }));
    expect(above.status).toBe(200);
    const nan = await adminSupplierSpendActivityCsvHandler(makeCtx({ days: 'nope' }));
    expect(nan.status).toBe(200);
  });

  it('appends a __TRUNCATED__ sentinel row when the result exceeds the cap', async () => {
    state.rows = Array.from({ length: 10_001 }, (_, i) => ({
      day: '2026-04-20',
      currency: 'USD',
      count: 1n,
      face_value_minor: i,
      wholesale_minor: i,
      user_cashback_minor: 0,
      loop_margin_minor: 0,
    }));
    const res = await adminSupplierSpendActivityCsvHandler(makeCtx());
    const body = await res.text();
    expect(body).toContain('\r\n__TRUNCATED__\r\n');
  });

  it('500s when the DB throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminSupplierSpendActivityCsvHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
