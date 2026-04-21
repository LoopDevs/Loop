import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const { dbMock, state } = vi.hoisted(() => {
  // Two distinct .select() calls in the handler — one against
  // user_credits, one against credit_transactions. Differentiate by
  // making select() return a table-scoped chain that holds its own
  // rows. Simpler approach: keep a FIFO of result arrays; each
  // .groupBy() (the terminal chain) dequeues one.
  const results: unknown[][] = [];
  const m: Record<string, ReturnType<typeof vi.fn>> = {};
  m['select'] = vi.fn(() => m);
  m['from'] = vi.fn(() => m);
  m['groupBy'] = vi.fn(async () => results.shift() ?? []);
  return { dbMock: m, state: { results } };
});

const operatorHealthMock = vi.fn();
const operatorSizeMock = vi.fn();

vi.mock('../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../db/schema.js', () => ({
  userCredits: {
    currency: 'currency',
    balanceMinor: 'balanceMinor',
  },
  creditTransactions: {
    currency: 'currency',
    type: 'type',
    amountMinor: 'amountMinor',
  },
  HOME_CURRENCIES: ['USD', 'GBP', 'EUR'] as const,
}));
// Payout-asset resolver — returns the static code mapping; issuer
// stays null so tests don't depend on env. Individual tests that
// exercise the issuer-populated path override this mock locally.
vi.mock('../../credits/payout-asset.js', () => ({
  payoutAssetFor: (currency: 'USD' | 'GBP' | 'EUR') => ({
    code: { USD: 'USDLOOP', GBP: 'GBPLOOP', EUR: 'EURLOOP' }[currency],
    issuer: null,
  }),
}));
vi.mock('../../ctx/operator-pool.js', () => ({
  getOperatorHealth: () => operatorHealthMock(),
  operatorPoolSize: () => operatorSizeMock(),
}));

import { treasuryHandler } from '../treasury.js';

function makeCtx(): { ctx: Context } {
  return {
    ctx: {
      json: (body: unknown, status?: number) =>
        new Response(JSON.stringify(body), {
          status: status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
    } as unknown as Context,
  };
}

beforeEach(() => {
  state.results.length = 0;
  operatorHealthMock.mockReset();
  operatorSizeMock.mockReset();
  for (const fn of Object.values(dbMock)) {
    if (typeof fn === 'function' && 'mockClear' in fn) {
      (fn as unknown as { mockClear: () => void }).mockClear();
    }
  }
  operatorHealthMock.mockReturnValue([]);
  operatorSizeMock.mockReturnValue(0);
});

describe('treasuryHandler', () => {
  it('returns an empty-shape snapshot when the ledger has no rows', async () => {
    state.results.push([], []); // outstanding, totals
    const { ctx } = makeCtx();
    const res = await treasuryHandler(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outstanding: Record<string, string>;
      totals: Record<string, Record<string, string>>;
      operatorPool: { size: number; operators: unknown[] };
    };
    expect(body.outstanding).toEqual({});
    expect(body.totals).toEqual({});
    expect(body.operatorPool).toEqual({ size: 0, operators: [] });
  });

  it('shapes outstanding balances per currency', async () => {
    state.results.push(
      [
        { currency: 'GBP', total: '1500' },
        { currency: 'USD', total: '4200' },
      ],
      [],
    );
    const { ctx } = makeCtx();
    const res = await treasuryHandler(ctx);
    const body = (await res.json()) as { outstanding: Record<string, string> };
    expect(body.outstanding).toEqual({ GBP: '1500', USD: '4200' });
  });

  it('groups totals by currency then type', async () => {
    state.results.push(
      [],
      [
        { currency: 'GBP', type: 'cashback', total: '1000' },
        { currency: 'GBP', type: 'interest', total: '25' },
        { currency: 'USD', type: 'cashback', total: '3200' },
      ],
    );
    const { ctx } = makeCtx();
    const res = await treasuryHandler(ctx);
    const body = (await res.json()) as { totals: Record<string, Record<string, string>> };
    expect(body.totals).toEqual({
      GBP: { cashback: '1000', interest: '25' },
      USD: { cashback: '3200' },
    });
  });

  it('reframes outstanding balances as LOOP-asset liabilities (ADR 015)', async () => {
    state.results.push(
      [
        { currency: 'GBP', total: '1500' },
        { currency: 'USD', total: '4200' },
      ],
      [],
    );
    const { ctx } = makeCtx();
    const res = await treasuryHandler(ctx);
    const body = (await res.json()) as {
      liabilities: Record<string, { outstandingMinor: string; issuer: string | null }>;
    };
    expect(body.liabilities).toEqual({
      USDLOOP: { outstandingMinor: '4200', issuer: null },
      GBPLOOP: { outstandingMinor: '1500', issuer: null },
      EURLOOP: { outstandingMinor: '0', issuer: null },
    });
  });

  it('always emits all three LOOP-asset slots so the UI shape is stable', async () => {
    state.results.push([], []);
    const { ctx } = makeCtx();
    const res = await treasuryHandler(ctx);
    const body = (await res.json()) as { liabilities: Record<string, unknown> };
    expect(Object.keys(body.liabilities).sort()).toEqual(['EURLOOP', 'GBPLOOP', 'USDLOOP']);
  });

  it('surfaces USDC + XLM assets with null stroops until the Horizon-read slice lands', async () => {
    state.results.push([], []);
    const { ctx } = makeCtx();
    const res = await treasuryHandler(ctx);
    const body = (await res.json()) as {
      assets: { USDC: { stroops: string | null }; XLM: { stroops: string | null } };
    };
    expect(body.assets.USDC.stroops).toBeNull();
    expect(body.assets.XLM.stroops).toBeNull();
  });

  it('includes the operator-pool snapshot', async () => {
    state.results.push([], []);
    operatorSizeMock.mockReturnValue(2);
    operatorHealthMock.mockReturnValue([
      { id: 'primary', state: 'closed' },
      { id: 'backup-1', state: 'open' },
    ]);
    const { ctx } = makeCtx();
    const res = await treasuryHandler(ctx);
    const body = (await res.json()) as { operatorPool: { size: number; operators: unknown[] } };
    expect(body.operatorPool.size).toBe(2);
    expect(body.operatorPool.operators).toEqual([
      { id: 'primary', state: 'closed' },
      { id: 'backup-1', state: 'open' },
    ]);
  });
});
