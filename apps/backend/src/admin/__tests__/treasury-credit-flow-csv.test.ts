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

vi.mock('../../db/schema.js', () => ({
  HOME_CURRENCIES: ['USD', 'GBP', 'EUR'] as const,
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminTreasuryCreditFlowCsvHandler } from '../treasury-credit-flow-csv.js';

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

describe('adminTreasuryCreditFlowCsvHandler', () => {
  it('returns the header row alone when the DB returns nothing', async () => {
    const res = await adminTreasuryCreditFlowCsvHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = await res.text();
    expect(body).toBe('day,currency,credited_minor,debited_minor,net_minor\r\n');
  });

  it('emits Content-Disposition with a stable treasury-credit-flow filename', async () => {
    const res = await adminTreasuryCreditFlowCsvHandler(makeCtx());
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toMatch(/attachment; filename="treasury-credit-flow-\d{4}-\d{2}-\d{2}\.csv"/);
  });

  it('maps credited/debited/net with bigint precision past 2^53', async () => {
    state.rows = [
      {
        day: '2026-04-20',
        currency: 'USD',
        credited_minor: '9007199254740992',
        debited_minor: '1',
      },
    ];
    const res = await adminTreasuryCreditFlowCsvHandler(makeCtx());
    const body = await res.text();
    expect(body.split('\r\n')[1]).toBe('2026-04-20,USD,9007199254740992,1,9007199254740991');
  });

  it('renders a negative net (debits outpace credits)', async () => {
    state.rows = [
      {
        day: '2026-04-20',
        currency: 'USD',
        credited_minor: '100',
        debited_minor: '400',
      },
    ];
    const res = await adminTreasuryCreditFlowCsvHandler(makeCtx());
    const body = await res.text();
    expect(body.split('\r\n')[1]).toBe('2026-04-20,USD,100,400,-300');
  });

  it('zero-fill rows carry empty currency + all zeros', async () => {
    state.rows = [{ day: '2026-04-20', currency: null, credited_minor: 0n, debited_minor: 0n }];
    const res = await adminTreasuryCreditFlowCsvHandler(makeCtx({ currency: 'USD' }));
    const body = await res.text();
    expect(body.split('\r\n')[1]).toBe('2026-04-20,,0,0,0');
  });

  it('normalises ?currency to upper case', async () => {
    const res = await adminTreasuryCreditFlowCsvHandler(makeCtx({ currency: 'gbp' }));
    expect(res.status).toBe(200);
  });

  it('400s on unknown ?currency', async () => {
    const res = await adminTreasuryCreditFlowCsvHandler(makeCtx({ currency: 'JPY' }));
    expect(res.status).toBe(400);
  });

  it('clamps ?days to [1, 366] and falls back for NaN', async () => {
    const below = await adminTreasuryCreditFlowCsvHandler(makeCtx({ days: '0' }));
    expect(below.status).toBe(200);
    const above = await adminTreasuryCreditFlowCsvHandler(makeCtx({ days: '9999' }));
    expect(above.status).toBe(200);
    const nan = await adminTreasuryCreditFlowCsvHandler(makeCtx({ days: 'nope' }));
    expect(nan.status).toBe(200);
  });

  it('appends __TRUNCATED__ on cap overflow', async () => {
    state.rows = Array.from({ length: 10_001 }, (_, i) => ({
      day: '2026-04-20',
      currency: 'USD',
      credited_minor: i,
      debited_minor: 0,
    }));
    const res = await adminTreasuryCreditFlowCsvHandler(makeCtx());
    const body = await res.text();
    expect(body).toContain('\r\n__TRUNCATED__\r\n');
  });

  it('500s when the DB throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminTreasuryCreditFlowCsvHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
