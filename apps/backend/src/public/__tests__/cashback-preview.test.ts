import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  configRows: [] as Array<{ userCashbackPct: string }>,
  throwErr: null as Error | null,
  merchantsById: new Map<string, { id: string; name: string; currency: string }>(),
  merchantsBySlug: new Map<string, { id: string; name: string; currency: string }>(),
}));

const limitMock = vi.fn(async () => {
  if (state.throwErr !== null) throw state.throwErr;
  return state.configRows;
});
const whereMock = vi.fn(() => ({ limit: limitMock }));
const fromMock = vi.fn(() => ({ where: whereMock }));
const selectMock = vi.fn(() => ({ from: fromMock }));

vi.mock('../../db/client.js', () => ({
  db: { select: () => selectMock() },
}));

vi.mock('../../db/schema.js', () => ({
  merchantCashbackConfigs: {
    merchantId: 'merchant_cashback_configs.merchant_id',
    userCashbackPct: 'merchant_cashback_configs.user_cashback_pct',
    active: 'merchant_cashback_configs.active',
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = (await vi.importActual('drizzle-orm')) as Record<string, unknown>;
  return {
    ...actual,
    eq: (col: unknown, value: unknown) => ({ __eq: true, col, value }),
    and: (...parts: unknown[]) => ({ __and: true, parts }),
  };
});

vi.mock('../../merchants/sync.js', () => ({
  getMerchants: () => ({
    merchantsById: state.merchantsById,
    merchantsBySlug: state.merchantsBySlug,
  }),
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import {
  publicCashbackPreviewHandler,
  cashbackPctToBps,
  previewCashbackMinor,
} from '../cashback-preview.js';

function makeCtx(query: Record<string, string> = {}): Context {
  return {
    req: {
      query: (k: string) => query[k],
      param: (_k: string) => undefined,
    },
    header: (_name: string, _value: string) => undefined,
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  state.configRows = [];
  state.throwErr = null;
  state.merchantsById = new Map([
    ['amazon-us', { id: 'amazon-us', name: 'Amazon', currency: 'USD' }],
  ]);
  state.merchantsBySlug = new Map([
    ['amazon', { id: 'amazon-us', name: 'Amazon', currency: 'USD' }],
  ]);
});

describe('cashbackPctToBps', () => {
  it('converts numeric(5,2) string → bps', () => {
    expect(cashbackPctToBps('0')).toBe(0);
    expect(cashbackPctToBps('2.50')).toBe(250);
    expect(cashbackPctToBps('5.00')).toBe(500);
    expect(cashbackPctToBps('10')).toBe(1000);
  });

  it('returns null on malformed / out-of-range input', () => {
    expect(cashbackPctToBps('nope')).toBeNull();
    expect(cashbackPctToBps('-1')).toBeNull();
    expect(cashbackPctToBps('101')).toBeNull();
  });
});

describe('previewCashbackMinor', () => {
  it('returns floor(amount × bps / 10 000)', () => {
    expect(previewCashbackMinor(10_000n, 250)).toBe(250n); // $100 at 2.50% → $2.50
    expect(previewCashbackMinor(9999n, 250)).toBe(249n); // floor rounds down
    expect(previewCashbackMinor(1_000_000n, 550)).toBe(55_000n); // $10k at 5.50%
  });

  it('returns 0n on zero / negative amount + zero bps', () => {
    expect(previewCashbackMinor(0n, 250)).toBe(0n);
    expect(previewCashbackMinor(-5n, 250)).toBe(0n);
    expect(previewCashbackMinor(10_000n, 0)).toBe(0n);
  });
});

describe('publicCashbackPreviewHandler', () => {
  it('400 when merchantId is missing', async () => {
    const res = await publicCashbackPreviewHandler(makeCtx({ amountMinor: '100' }));
    expect(res.status).toBe(400);
  });

  it('400 when amountMinor is missing', async () => {
    const res = await publicCashbackPreviewHandler(makeCtx({ merchantId: 'amazon-us' }));
    expect(res.status).toBe(400);
  });

  it('400 on malformed amountMinor', async () => {
    const badShapes = ['abc', '1.5', '1e5', '-5', ''];
    for (const s of badShapes) {
      const res = await publicCashbackPreviewHandler(
        makeCtx({ merchantId: 'amazon-us', amountMinor: s }),
      );
      expect(res.status).toBe(400);
    }
  });

  it('400 when amountMinor is zero or exceeds the ceiling', async () => {
    const zero = await publicCashbackPreviewHandler(
      makeCtx({ merchantId: 'amazon-us', amountMinor: '0' }),
    );
    expect(zero.status).toBe(400);

    const tooBig = await publicCashbackPreviewHandler(
      makeCtx({ merchantId: 'amazon-us', amountMinor: '99999999999' }),
    );
    expect(tooBig.status).toBe(400);
  });

  it('404 on unknown merchant id', async () => {
    const res = await publicCashbackPreviewHandler(
      makeCtx({ merchantId: 'unknown-merchant', amountMinor: '1000' }),
    );
    expect(res.status).toBe(404);
  });

  it('resolves via merchant slug and returns the floor-rounded preview', async () => {
    state.configRows = [{ userCashbackPct: '2.50' }];
    const res = await publicCashbackPreviewHandler(
      makeCtx({ merchantId: 'amazon', amountMinor: '10000' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      merchantId: string;
      merchantName: string;
      cashbackPct: string | null;
      cashbackMinor: string;
      currency: string;
    };
    expect(body.merchantName).toBe('Amazon');
    expect(body.cashbackPct).toBe('2.50');
    expect(body.cashbackMinor).toBe('250'); // $2.50 on $100
    expect(body.currency).toBe('USD');
  });

  it('returns the "coming soon" shape when no active config exists', async () => {
    state.configRows = [];
    const res = await publicCashbackPreviewHandler(
      makeCtx({ merchantId: 'amazon-us', amountMinor: '10000' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cashbackPct: string | null; cashbackMinor: string };
    expect(body.cashbackPct).toBeNull();
    expect(body.cashbackMinor).toBe('0');
  });

  it('falls back to soft-empty on DB failure (ADR 020 never-500)', async () => {
    state.throwErr = new Error('db exploded');
    const res = await publicCashbackPreviewHandler(
      makeCtx({ merchantId: 'amazon-us', amountMinor: '10000' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cashbackPct: string | null; cashbackMinor: string };
    expect(body.cashbackPct).toBeNull();
    expect(body.cashbackMinor).toBe('0');
  });
});
