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

import { adminSupplierMarginDailyCsvHandler } from '../supplier-margin-daily-csv.js';

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

describe('adminSupplierMarginDailyCsvHandler', () => {
  it('emits just the header on empty result', async () => {
    const res = await adminSupplierMarginDailyCsvHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-disposition')).toMatch(
      /attachment; filename="supplier-margin-daily-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    const body = await res.text();
    expect(body).toBe(
      'day,currency,charge_minor,wholesale_minor,user_cashback_minor,loop_margin_minor,order_count,margin_bps\r\n',
    );
  });

  it('drops LEFT-JOIN null-currency rows and computes margin_bps via the shared helper', async () => {
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
        currency: 'GBP',
        charge: '5000',
        wholesale: '4000',
        user_cashback: '750',
        loop_margin: '250',
        order_count: 1,
      },
    ];
    const res = await adminSupplierMarginDailyCsvHandler(makeCtx());
    const body = await res.text();
    const lines = body.trimEnd().split('\r\n');
    expect(lines).toEqual([
      'day,currency,charge_minor,wholesale_minor,user_cashback_minor,loop_margin_minor,order_count,margin_bps',
      '2026-04-15,USD,10000,8000,1500,500,2,500', // 500/10000×10000 = 500 bps
      '2026-04-16,GBP,5000,4000,750,250,1,500',
    ]);
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
    const res = await adminSupplierMarginDailyCsvHandler(makeCtx());
    const body = await res.text();
    expect(body).toContain('2026-04-15,USD,1000,800,150,50,1,500');
  });

  it('tolerates { rows } envelope from pg driver', async () => {
    state.rows = {
      rows: [
        {
          day: '2026-04-15',
          currency: 'USD',
          charge: '100',
          wholesale: '80',
          user_cashback: '15',
          loop_margin: '5',
          order_count: 1,
        },
      ],
    } as unknown as Array<Record<string, unknown>>;
    const res = await adminSupplierMarginDailyCsvHandler(makeCtx());
    const body = await res.text();
    expect(body).toContain('2026-04-15,USD,100,80,15,5,1,500');
  });

  it('500 on DB failure', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminSupplierMarginDailyCsvHandler(makeCtx());
    expect(res.status).toBe(500);
  });

  it('clamps ?days to 1..366', async () => {
    const over = await adminSupplierMarginDailyCsvHandler(makeCtx({ days: '9000' }));
    expect(over.status).toBe(200);
    const under = await adminSupplierMarginDailyCsvHandler(makeCtx({ days: '0' }));
    expect(under.status).toBe(200);
  });

  it('appends __TRUNCATED__ sentinel past 10 000 rows', async () => {
    state.rows = Array.from({ length: 10_001 }, (_, i) => ({
      day: '2026-04-15',
      currency: 'USD',
      charge: String((i + 1) * 100),
      wholesale: '80',
      user_cashback: '15',
      loop_margin: '5',
      order_count: 1,
    }));
    const res = await adminSupplierMarginDailyCsvHandler(makeCtx());
    const body = await res.text();
    expect(body.endsWith('__TRUNCATED__\r\n')).toBe(true);
    const lines = body.trimEnd().split('\r\n');
    // header + 10 000 data rows + truncation sentinel = 10 002 lines.
    expect(lines).toHaveLength(10_002);
  });
});
