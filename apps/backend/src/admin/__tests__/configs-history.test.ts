import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  throwErr: null as Error | null,
  merchantsById: new Map<string, { id: string; name: string }>(),
}));

const limitMock = vi.fn(async () => {
  if (state.throwErr !== null) throw state.throwErr;
  return state.rows;
});
const orderByMock = vi.fn(() => ({ limit: limitMock }));
const fromMock = vi.fn(() => ({ orderBy: orderByMock }));
const selectMock = vi.fn(() => ({ from: fromMock }));

vi.mock('../../db/client.js', () => ({
  db: { select: () => selectMock() },
}));

vi.mock('../../db/schema.js', () => ({
  merchantCashbackConfigHistory: {
    id: 'h.id',
    merchantId: 'h.merchant_id',
    wholesalePct: 'h.wholesale_pct',
    userCashbackPct: 'h.user_cashback_pct',
    loopMarginPct: 'h.loop_margin_pct',
    active: 'h.active',
    changedBy: 'h.changed_by',
    changedAt: 'h.changed_at',
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = (await vi.importActual('drizzle-orm')) as Record<string, unknown>;
  return {
    ...actual,
    desc: (col: unknown) => ({ __desc: true, col }),
  };
});

vi.mock('../../merchants/sync.js', () => ({
  getMerchants: () => ({ merchantsById: state.merchantsById }),
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminConfigsHistoryHandler } from '../configs-history.js';

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
  state.merchantsById = new Map();
  limitMock.mockClear();
  orderByMock.mockClear();
  fromMock.mockClear();
  selectMock.mockClear();
});

describe('adminConfigsHistoryHandler', () => {
  it('returns an empty list when nothing has been edited', async () => {
    state.rows = [];
    const res = await adminConfigsHistoryHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { history: unknown[] };
    expect(body.history).toEqual([]);
  });

  it('enriches merchant name from the catalog and serialises changedAt as ISO-8601', async () => {
    state.merchantsById.set('amazon', { id: 'amazon', name: 'Amazon' });
    state.rows = [
      {
        id: '11111111-2222-3333-4444-555555555555',
        merchantId: 'amazon',
        wholesalePct: '70.00',
        userCashbackPct: '25.00',
        loopMarginPct: '5.00',
        active: true,
        changedBy: 'admin-abc',
        changedAt: new Date('2026-04-22T14:00:00Z'),
      },
    ];
    const res = await adminConfigsHistoryHandler(makeCtx());
    const body = (await res.json()) as {
      history: Array<Record<string, unknown>>;
    };
    expect(body.history[0]).toEqual({
      id: '11111111-2222-3333-4444-555555555555',
      merchantId: 'amazon',
      merchantName: 'Amazon',
      wholesalePct: '70.00',
      userCashbackPct: '25.00',
      loopMarginPct: '5.00',
      active: true,
      changedBy: 'admin-abc',
      changedAt: '2026-04-22T14:00:00.000Z',
    });
  });

  it('falls back to merchantId as the display name for evicted-catalog rows (ADR 021 Rule A)', async () => {
    state.merchantsById = new Map();
    state.rows = [
      {
        id: '22222222-2222-2222-2222-222222222222',
        merchantId: 'ghost',
        wholesalePct: '50.00',
        userCashbackPct: '40.00',
        loopMarginPct: '10.00',
        active: true,
        changedBy: 'admin-x',
        changedAt: new Date('2026-04-22T00:00:00Z'),
      },
    ];
    const res = await adminConfigsHistoryHandler(makeCtx());
    const body = (await res.json()) as { history: Array<{ merchantName: string }> };
    expect(body.history[0]?.merchantName).toBe('ghost');
  });

  it.each([
    { input: '0', note: 'below the floor clamps up' },
    { input: '500', note: 'above the ceiling clamps down' },
    { input: 'nonsense', note: 'non-numeric falls to default' },
    { input: '25', note: 'in-range value passes through' },
  ])('accepts ?limit=$input without a 400 ($note)', async ({ input }) => {
    const res = await adminConfigsHistoryHandler(makeCtx({ limit: input }));
    expect(res.status).toBe(200);
  });

  it('500 when the DB query throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminConfigsHistoryHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
