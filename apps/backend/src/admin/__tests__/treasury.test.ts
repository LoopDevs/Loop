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

// Env + Horizon balance reader — each test controls what the admin
// operator's on-chain balances look like + whether the env is wired
// at all. Default: no deposit address configured → assets null.
const { envState, balancesState } = vi.hoisted(() => ({
  envState: {
    LOOP_STELLAR_DEPOSIT_ADDRESS: undefined as string | undefined,
    LOOP_STELLAR_USDC_ISSUER: undefined as string | undefined,
  },
  balancesState: {
    snapshot: null as null | {
      xlmStroops: bigint | null;
      usdcStroops: bigint | null;
      asOfMs: number;
    },
    throwErr: null as Error | null,
  },
}));
vi.mock('../../env.js', () => ({
  get env() {
    return envState;
  },
}));
vi.mock('../../payments/horizon-balances.js', () => ({
  getAccountBalances: vi.fn(async () => {
    if (balancesState.throwErr !== null) throw balancesState.throwErr;
    return balancesState.snapshot ?? { xlmStroops: null, usdcStroops: null, asOfMs: Date.now() };
  }),
}));
vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
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
  envState.LOOP_STELLAR_DEPOSIT_ADDRESS = undefined;
  envState.LOOP_STELLAR_USDC_ISSUER = undefined;
  balancesState.snapshot = null;
  balancesState.throwErr = null;
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

  it('assets are null when LOOP_STELLAR_DEPOSIT_ADDRESS is unset (dev / pre-deploy)', async () => {
    state.results.push([], []);
    const { ctx } = makeCtx();
    const res = await treasuryHandler(ctx);
    const body = (await res.json()) as {
      assets: { USDC: { stroops: string | null }; XLM: { stroops: string | null } };
    };
    expect(body.assets.USDC.stroops).toBeNull();
    expect(body.assets.XLM.stroops).toBeNull();
  });

  it('populates USDC + XLM stroops from Horizon when the deposit address is set', async () => {
    state.results.push([], []);
    envState.LOOP_STELLAR_DEPOSIT_ADDRESS = 'GACCOUNT';
    envState.LOOP_STELLAR_USDC_ISSUER = 'GCENTRE';
    balancesState.snapshot = {
      xlmStroops: 1_234_567_890n,
      usdcStroops: 5_000_000_000n,
      asOfMs: Date.now(),
    };
    const { ctx } = makeCtx();
    const res = await treasuryHandler(ctx);
    const body = (await res.json()) as {
      assets: { USDC: { stroops: string }; XLM: { stroops: string } };
    };
    expect(body.assets.USDC.stroops).toBe('5000000000');
    expect(body.assets.XLM.stroops).toBe('1234567890');
  });

  it('preserves null stroops when the account has no trustline for USDC', async () => {
    state.results.push([], []);
    envState.LOOP_STELLAR_DEPOSIT_ADDRESS = 'GACCOUNT';
    balancesState.snapshot = {
      xlmStroops: 10n,
      usdcStroops: null,
      asOfMs: Date.now(),
    };
    const { ctx } = makeCtx();
    const res = await treasuryHandler(ctx);
    const body = (await res.json()) as {
      assets: { USDC: { stroops: string | null }; XLM: { stroops: string | null } };
    };
    expect(body.assets.USDC.stroops).toBeNull();
    expect(body.assets.XLM.stroops).toBe('10');
  });

  it('falls back to null assets when Horizon throws — does not 500 the handler', async () => {
    state.results.push([], []);
    envState.LOOP_STELLAR_DEPOSIT_ADDRESS = 'GACCOUNT';
    balancesState.throwErr = new Error('Horizon 503');
    const { ctx } = makeCtx();
    const res = await treasuryHandler(ctx);
    expect(res.status).toBe(200);
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
