import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  ledgerRows: [] as unknown,
  balanceRows: [] as unknown,
  throwErr: null as Error | null,
  throwOnCall: 0 as 0 | 1 | 2, // which db.execute call should throw
}));

vi.mock('../../db/client.js', () => ({
  db: {
    execute: vi.fn(async () => {
      state.throwOnCall += 1;
      if (state.throwErr !== null && state.throwOnCall >= 1) throw state.throwErr;
      // First call → ledger agg, second → balance agg.
      if (state.throwOnCall === 1) return state.ledgerRows;
      return state.balanceRows;
    }),
  },
}));

vi.mock('../../db/schema.js', () => ({
  creditTransactions: {
    currency: 'credit_transactions.currency',
    type: 'credit_transactions.type',
    amountMinor: 'credit_transactions.amount_minor',
  },
  userCredits: {
    currency: 'user_credits.currency',
    balanceMinor: 'user_credits.balance_minor',
  },
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminCashbackRealizationHandler, recycledBps } from '../cashback-realization.js';

function makeCtx(): Context {
  return {
    req: { query: (_k: string) => undefined, param: (_k: string) => undefined },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  state.ledgerRows = [];
  state.balanceRows = [];
  state.throwErr = null;
  state.throwOnCall = 0;
});

describe('recycledBps', () => {
  it('returns 0 when earned is zero (div-by-zero guard)', () => {
    expect(recycledBps(0n, 0n)).toBe(0);
    expect(recycledBps(0n, 100n)).toBe(0);
  });

  it('computes basis points = spent / earned × 10 000', () => {
    expect(recycledBps(100n, 25n)).toBe(2500); // 25.00%
    expect(recycledBps(100n, 50n)).toBe(5000); // 50.00%
    expect(recycledBps(100n, 100n)).toBe(10000); // 100.00%
  });

  it('clamps corrupt data (spent > earned) rather than crashing', () => {
    expect(recycledBps(100n, 200n)).toBe(10000);
  });

  it('treats negative spent as zero (defensive)', () => {
    expect(recycledBps(100n, -50n)).toBe(0);
  });
});

describe('adminCashbackRealizationHandler', () => {
  it('returns empty rows when the ledger is empty', async () => {
    state.ledgerRows = [{ currency: null, earned: '0', spent: '0', withdrawn: '0' }];
    state.balanceRows = [{ currency: null, outstanding: '0' }];
    const res = await adminCashbackRealizationHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    // Fleet-wide row always present even when earned = 0.
    expect(body.rows).toHaveLength(1);
  });

  it('maps per-currency + fleet-wide rows with correct recycledBps', async () => {
    state.ledgerRows = [
      { currency: null, earned: '300000', spent: '75000', withdrawn: '5000' }, // fleet
      { currency: 'USD', earned: '200000', spent: '50000', withdrawn: '5000' },
      { currency: 'GBP', earned: '100000', spent: '25000', withdrawn: '0' },
    ];
    state.balanceRows = [
      { currency: null, outstanding: '220000' },
      { currency: 'USD', outstanding: '145000' },
      { currency: 'GBP', outstanding: '75000' },
    ];
    const res = await adminCashbackRealizationHandler(makeCtx());
    const body = (await res.json()) as {
      rows: Array<{
        currency: string | null;
        earnedMinor: string;
        spentMinor: string;
        outstandingMinor: string;
        recycledBps: number;
      }>;
    };
    // Fleet first, per-currency alphabetical.
    expect(body.rows[0]!.currency).toBeNull();
    expect(body.rows[1]!.currency).toBe('GBP');
    expect(body.rows[2]!.currency).toBe('USD');
    // Bps: 75000/300000 = 2500 (25%) fleet; 50000/200000 = 2500 USD;
    // 25000/100000 = 2500 GBP.
    expect(body.rows[0]!.recycledBps).toBe(2500);
    expect(body.rows[1]!.recycledBps).toBe(2500);
    // Outstanding balance carries through from the balance-agg result.
    expect(body.rows[2]!.outstandingMinor).toBe('145000');
  });

  it('omits per-currency rows with zero earned cashback but keeps the aggregate', async () => {
    state.ledgerRows = [
      { currency: null, earned: '100', spent: '0', withdrawn: '0' },
      { currency: 'USD', earned: '100', spent: '0', withdrawn: '0' },
      { currency: 'GBP', earned: '0', spent: '0', withdrawn: '0' }, // no cashback in GBP yet
    ];
    state.balanceRows = [
      { currency: null, outstanding: '100' },
      { currency: 'USD', outstanding: '100' },
      { currency: 'GBP', outstanding: '0' },
    ];
    const res = await adminCashbackRealizationHandler(makeCtx());
    const body = (await res.json()) as { rows: Array<{ currency: string | null }> };
    expect(body.rows).toHaveLength(2);
    expect(body.rows.map((r) => r.currency)).toEqual([null, 'USD']);
  });

  it('tolerates { rows } envelope from pg driver', async () => {
    state.ledgerRows = {
      rows: [{ currency: null, earned: '100', spent: '50', withdrawn: '0' }],
    };
    state.balanceRows = { rows: [{ currency: null, outstanding: '50' }] };
    const res = await adminCashbackRealizationHandler(makeCtx());
    const body = (await res.json()) as { rows: Array<{ currency: string | null }> };
    expect(body.rows).toHaveLength(1);
  });

  it('500 when the aggregate throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminCashbackRealizationHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
