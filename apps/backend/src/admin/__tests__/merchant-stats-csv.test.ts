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
    currency: 'orders.currency',
    userId: 'orders.user_id',
    state: 'orders.state',
    fulfilledAt: 'orders.fulfilled_at',
    faceValueMinor: 'orders.face_value_minor',
    wholesaleMinor: 'orders.wholesale_minor',
    userCashbackMinor: 'orders.user_cashback_minor',
    loopMarginMinor: 'orders.loop_margin_minor',
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

import { adminMerchantStatsCsvHandler } from '../merchant-stats-csv.js';

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

describe('adminMerchantStatsCsvHandler', () => {
  it('returns just the header row when the window is empty', async () => {
    const res = await adminMerchantStatsCsvHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="merchant-stats-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const body = await res.text();
    expect(body.startsWith('merchant_id,currency,order_count,unique_user_count,')).toBe(true);
    expect(body.split('\r\n').filter((l) => l.length > 0)).toHaveLength(1);
  });

  it('emits one row per (merchant, currency) with bigint + Date coercion', async () => {
    state.rows = [
      {
        merchant_id: 'argos',
        currency: 'GBP',
        order_count: 3n,
        unique_user_count: '2',
        face_value_minor: 15_000n,
        wholesale_minor: '12000',
        user_cashback_minor: 1800,
        loop_margin_minor: 1200n,
        last_fulfilled_at: new Date('2026-04-20T10:00:00Z'),
      },
      {
        merchant_id: 'tesco',
        currency: 'GBP',
        order_count: 1,
        unique_user_count: 1,
        face_value_minor: '5000',
        wholesale_minor: '4000',
        user_cashback_minor: '600',
        loop_margin_minor: '400',
        last_fulfilled_at: '2026-04-18T14:00:00Z',
      },
    ];
    const res = await adminMerchantStatsCsvHandler(makeCtx());
    const body = await res.text();
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('argos,GBP,3,2,15000,12000,1800,1200,2026-04-20T10:00:00.000Z');
    expect(lines[2]).toBe('tesco,GBP,1,1,5000,4000,600,400,2026-04-18T14:00:00.000Z');
  });

  it('RFC 4180 — escapes quotes + commas in a merchant slug with punctuation', async () => {
    state.rows = [
      {
        merchant_id: 'weird, "quoted" slug',
        currency: 'GBP',
        order_count: 1n,
        unique_user_count: 1n,
        face_value_minor: 100n,
        wholesale_minor: 80n,
        user_cashback_minor: 10n,
        loop_margin_minor: 10n,
        last_fulfilled_at: '2026-04-22T00:00:00Z',
      },
    ];
    const res = await adminMerchantStatsCsvHandler(makeCtx());
    const body = await res.text();
    expect(body).toContain('"weird, ""quoted"" slug"');
  });

  it('truncates with __TRUNCATED__ sentinel past 10 000 rows', async () => {
    state.rows = Array.from({ length: 10_001 }, (_, i) => ({
      merchant_id: `mer-${i}`,
      currency: 'GBP',
      order_count: 1n,
      unique_user_count: 1n,
      face_value_minor: 100n,
      wholesale_minor: 80n,
      user_cashback_minor: 10n,
      loop_margin_minor: 10n,
      last_fulfilled_at: '2026-04-22T00:00:00Z',
    }));
    const res = await adminMerchantStatsCsvHandler(makeCtx());
    const body = await res.text();
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(10_002);
    expect(lines[lines.length - 1]).toBe('__TRUNCATED__');
  });

  it('accepts ?since and echoes the date in the filename', async () => {
    const res = await adminMerchantStatsCsvHandler(makeCtx({ since: '2026-04-01T00:00:00Z' }));
    expect(res.headers.get('content-disposition')).toContain('merchant-stats-2026-04-01.csv');
  });

  it('400 on malformed ?since', async () => {
    const res = await adminMerchantStatsCsvHandler(makeCtx({ since: 'not-a-date' }));
    expect(res.status).toBe(400);
  });

  it('400 when since is more than 366 days ago', async () => {
    const tooOld = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const res = await adminMerchantStatsCsvHandler(makeCtx({ since: tooOld }));
    expect(res.status).toBe(400);
  });

  it('tolerates { rows } envelope from pg driver', async () => {
    state.rows = {
      rows: [
        {
          merchant_id: 'amazon',
          currency: 'USD',
          order_count: 2n,
          unique_user_count: 2n,
          face_value_minor: 20_000n,
          wholesale_minor: 16_000n,
          user_cashback_minor: 2_400n,
          loop_margin_minor: 1_600n,
          last_fulfilled_at: '2026-04-22T00:00:00Z',
        },
      ],
    } as unknown as Array<Record<string, unknown>>;
    const res = await adminMerchantStatsCsvHandler(makeCtx());
    const body = await res.text();
    expect(body).toContain('amazon,USD,2,2,20000,16000,2400,1600,2026-04-22T00:00:00.000Z');
  });

  it('500 when the aggregate throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminMerchantStatsCsvHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
