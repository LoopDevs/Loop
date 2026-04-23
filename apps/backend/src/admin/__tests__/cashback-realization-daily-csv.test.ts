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

import { adminCashbackRealizationDailyCsvHandler } from '../cashback-realization-daily-csv.js';

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

describe('adminCashbackRealizationDailyCsvHandler', () => {
  it('emits just the header row on empty ledger', async () => {
    const res = await adminCashbackRealizationDailyCsvHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-disposition')).toMatch(
      /attachment; filename="cashback-realization-daily-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    const body = await res.text();
    expect(body).toBe('day,currency,earned_minor,spent_minor,recycled_bps\r\n');
  });

  it('drops LEFT-JOIN null-currency rows and renders recycled_bps via shared helper', async () => {
    state.rows = [
      // Zero-day row — dropped.
      { day: '2026-04-15', currency: null, earned_minor: '0', spent_minor: '0' },
      { day: '2026-04-15', currency: 'USD', earned_minor: '10000', spent_minor: '2500' },
      { day: '2026-04-16', currency: 'GBP', earned_minor: '5000', spent_minor: '0' },
    ];
    const res = await adminCashbackRealizationDailyCsvHandler(makeCtx());
    const body = await res.text();
    const lines = body.trimEnd().split('\r\n');
    expect(lines).toEqual([
      'day,currency,earned_minor,spent_minor,recycled_bps',
      '2026-04-15,USD,10000,2500,2500', // 2500/10000 = 25.00%
      '2026-04-16,GBP,5000,0,0',
    ]);
  });

  it('accepts Date objects in the day column (pg driver returns Date for ::date)', async () => {
    state.rows = [
      {
        day: new Date('2026-04-15T00:00:00Z'),
        currency: 'USD',
        earned_minor: '1000',
        spent_minor: '500',
      },
    ];
    const res = await adminCashbackRealizationDailyCsvHandler(makeCtx());
    const body = await res.text();
    expect(body).toContain('2026-04-15,USD,1000,500,5000');
  });

  it('tolerates { rows } envelope from pg driver', async () => {
    state.rows = {
      rows: [{ day: '2026-04-15', currency: 'USD', earned_minor: '1000', spent_minor: '250' }],
    } as unknown as Array<Record<string, unknown>>;
    const res = await adminCashbackRealizationDailyCsvHandler(makeCtx());
    const body = await res.text();
    expect(body).toContain('2026-04-15,USD,1000,250,2500');
  });

  it('500 on DB failure', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminCashbackRealizationDailyCsvHandler(makeCtx());
    expect(res.status).toBe(500);
  });

  it('clamps ?days to 1..366', async () => {
    const over = await adminCashbackRealizationDailyCsvHandler(makeCtx({ days: '9000' }));
    expect(over.status).toBe(200);
    const under = await adminCashbackRealizationDailyCsvHandler(makeCtx({ days: '0' }));
    expect(under.status).toBe(200);
  });

  it('appends __TRUNCATED__ sentinel past 10 000 rows', async () => {
    state.rows = Array.from({ length: 10_001 }, (_, i) => ({
      day: '2026-04-15',
      currency: 'USD',
      earned_minor: String(i + 1),
      spent_minor: '0',
    }));
    const res = await adminCashbackRealizationDailyCsvHandler(makeCtx());
    const body = await res.text();
    expect(body.endsWith('__TRUNCATED__\r\n')).toBe(true);
    const lines = body.trimEnd().split('\r\n');
    // header + 10 000 data rows + truncation sentinel = 10 002 lines.
    expect(lines).toHaveLength(10_002);
  });
});
