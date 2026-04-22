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

vi.mock('../../db/schema.js', () => ({
  orders: {
    merchantId: 'orders.merchant_id',
    state: 'orders.state',
    paymentMethod: 'orders.payment_method',
    chargeMinor: 'orders.charge_minor',
    fulfilledAt: 'orders.fulfilled_at',
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

import { adminMerchantFlywheelActivityCsvHandler } from '../merchant-flywheel-activity-csv.js';

function makeCtx(
  params: Record<string, string | undefined> = {},
  query: Record<string, string | undefined> = {},
): Context {
  return {
    req: {
      query: (k: string) => query[k],
      param: (k: string) => params[k],
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

describe('adminMerchantFlywheelActivityCsvHandler', () => {
  it('400 when merchantId is missing', async () => {
    const res = await adminMerchantFlywheelActivityCsvHandler(makeCtx({}));
    expect(res.status).toBe(400);
  });

  it('400 when merchantId has disallowed characters', async () => {
    const res = await adminMerchantFlywheelActivityCsvHandler(makeCtx({ merchantId: 'bad slug' }));
    expect(res.status).toBe(400);
  });

  it('returns header-only CSV when DB is empty', async () => {
    const res = await adminMerchantFlywheelActivityCsvHandler(makeCtx({ merchantId: 'amazon_us' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="amazon_us-flywheel-activity-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const body = await res.text();
    expect(
      body.startsWith('day,recycled_count,total_count,recycled_charge_minor,total_charge_minor'),
    ).toBe(true);
    expect(body.split('\r\n').filter((l) => l.length > 0)).toHaveLength(1);
  });

  it('emits one row per day with bigint + date coercion', async () => {
    state.rows = [
      {
        day: '2026-04-20',
        recycled_count: 3n,
        total_count: 10n,
        recycled_charge_minor: 6000n,
        total_charge_minor: 25000n,
      },
      {
        day: new Date('2026-04-21T00:00:00Z'),
        recycled_count: 0,
        total_count: 0,
        recycled_charge_minor: 0,
        total_charge_minor: 0,
      },
    ];
    const res = await adminMerchantFlywheelActivityCsvHandler(makeCtx({ merchantId: 'amazon_us' }));
    const lines = (await res.text()).split('\r\n').filter((l) => l.length > 0);
    expect(lines).toEqual([
      'day,recycled_count,total_count,recycled_charge_minor,total_charge_minor',
      '2026-04-20,3,10,6000,25000',
      '2026-04-21,0,0,0,0',
    ]);
  });

  it('preserves bigint precision past 2^53', async () => {
    state.rows = [
      {
        day: '2026-04-22',
        recycled_count: 1n,
        total_count: 1n,
        recycled_charge_minor: 9007199254740992n + 41n,
        total_charge_minor: 9007199254740992n + 41n,
      },
    ];
    const res = await adminMerchantFlywheelActivityCsvHandler(makeCtx({ merchantId: 'm-1' }));
    const body = await res.text();
    expect(body).toMatch(/9007199254741033/);
  });

  it('coerces null aggregates to 0 for zero-activity LEFT-JOIN days', async () => {
    state.rows = [
      {
        day: '2026-04-22',
        recycled_count: null,
        total_count: null,
        recycled_charge_minor: null,
        total_charge_minor: null,
      },
    ];
    const res = await adminMerchantFlywheelActivityCsvHandler(makeCtx({ merchantId: 'm-1' }));
    const body = await res.text();
    expect(body).toMatch(/\r\n2026-04-22,0,0,0,0\r\n/);
  });

  it('appends __TRUNCATED__ sentinel when the row cap is exceeded', async () => {
    state.rows = Array.from({ length: 10_001 }, (_, i) => ({
      day: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      recycled_count: 0n,
      total_count: 0n,
      recycled_charge_minor: 0n,
      total_charge_minor: 0n,
    }));
    const res = await adminMerchantFlywheelActivityCsvHandler(makeCtx({ merchantId: 'big' }));
    const lines = (await res.text()).split('\r\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(10_002);
    expect(lines.at(-1)).toBe('__TRUNCATED__');
  });

  it('500 when the db throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminMerchantFlywheelActivityCsvHandler(makeCtx({ merchantId: 'amazon_us' }));
    expect(res.status).toBe(500);
  });
});
