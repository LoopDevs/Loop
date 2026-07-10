import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import type { HorizonPayment } from '../horizon.js';

vi.mock('../../env.js', () => ({
  env: {
    LOOP_OPERATOR_FLOAT_XLM_THRESHOLD_STROOPS: 10_000_000n,
    LOOP_OPERATOR_FLOAT_USDC_THRESHOLD_STROOPS: 1n,
    LOOP_OPERATOR_FLOAT_RECONCILIATION_INTERVAL_HOURS: 24,
    LOOP_STELLAR_DEPOSIT_ADDRESS: 'GOPERATOR',
    LOOP_STELLAR_USDC_ISSUER: undefined,
  },
}));

const { horizonMocks } = vi.hoisted(() => ({
  horizonMocks: {
    listAccountPayments: vi.fn(async () => ({ records: [], nextCursor: null })),
    getAccountBalances: vi.fn(async () => ({ xlmStroops: 0n, usdcStroops: 0n })),
  },
}));
vi.mock('../horizon.js', () => ({
  listAccountPayments: () => horizonMocks.listAccountPayments(),
}));
vi.mock('../horizon-balances.js', () => ({
  getAccountBalances: () => horizonMocks.getAccountBalances(),
}));

// Chainable db mock routed by the `from(table)` argument — the module
// imports the REAL schema, so table identity distinguishes queries.
// `tableNameOf` is wired to drizzle's getTableName after imports
// resolve (same pattern as the interest-mint suite).
const { dbState, dbMock, advisoryState } = vi.hoisted(() => {
  const state = {
    /** FIFO of select results per table name. Empty/missing → []. */
    selectQueues: new Map<string, unknown[][]>(),
    updates: [] as Array<{ table: string; set: Record<string, unknown> }>,
    inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
    /** FIFO for raw `db.execute` results (computeMovementTotals). */
    executeQueue: [] as unknown[][],
    tableNameOf: (_t: unknown): string => '',
  };
  const nextRows = (table: unknown): unknown[] => {
    const q = state.selectQueues.get(state.tableNameOf(table));
    return q !== undefined && q.length > 0 ? (q.shift() as unknown[]) : [];
  };
  const select = (): unknown => ({
    from: (table: unknown): unknown => {
      const chain = {
        where: () => chain,
        orderBy: () => chain,
        limit: async () => nextRows(table),
        then: (resolve: (v: unknown) => unknown) => resolve(nextRows(table)),
      };
      return chain;
    },
  });
  const update = (table: unknown): unknown => ({
    set: (v: Record<string, unknown>) => ({
      where: async () => {
        state.updates.push({ table: state.tableNameOf(table), set: v });
      },
    }),
  });
  const insert = (table: unknown): unknown => ({
    values: async (v: Record<string, unknown>) => {
      state.inserts.push({ table: state.tableNameOf(table), values: v });
    },
  });
  const execute = async (): Promise<unknown[]> =>
    state.executeQueue.shift() ?? [
      { classified_delta: 0n, unclassified_count: 0, movement_count: 0 },
    ];
  return {
    dbState: state,
    dbMock: { select, update, insert, execute },
    advisoryState: { acquired: true },
  };
});

vi.mock('../../db/client.js', () => ({
  db: dbMock,
  withAdvisoryLock: async <T>(_key: bigint, fn: () => Promise<T>) =>
    advisoryState.acquired ? { ran: true as const, value: await fn() } : { ran: false as const },
}));

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) },
}));

vi.mock('../../discord.js', () => ({ notifyOperatorFloatDrift: vi.fn() }));
vi.mock('../../runtime-health.js', () => ({
  markWorkerStarted: vi.fn(),
  markWorkerStopped: vi.fn(),
  markWorkerTickFailure: vi.fn(),
  markWorkerTickSuccess: vi.fn(),
}));

import {
  classifyRun,
  computeExpectedBalance,
  extractOperatorMovement,
  reclassifyUnclassifiedMovements,
  runOperatorFloatReconciliationForAsset,
  startOperatorFloatReconciliationWatcher,
  stopOperatorFloatReconciliationWatcher,
  thresholdForAsset,
} from '../operator-float-reconciliation.js';
import { notifyOperatorFloatDrift } from '../../discord.js';
import { markWorkerTickSuccess, markWorkerTickFailure } from '../../runtime-health.js';

dbState.tableNameOf = (t: unknown): string => {
  try {
    return getTableName(t as Parameters<typeof getTableName>[0]);
  } catch {
    return '';
  }
};

function stage(table: string, rows: unknown[]): void {
  const q = dbState.selectQueues.get(table) ?? [];
  q.push(rows);
  dbState.selectQueues.set(table, q);
}

beforeEach(() => {
  dbState.selectQueues.clear();
  dbState.updates = [];
  dbState.inserts = [];
  dbState.executeQueue = [];
  advisoryState.acquired = true;
  horizonMocks.listAccountPayments.mockClear();
  horizonMocks.listAccountPayments.mockResolvedValue({ records: [], nextCursor: null });
  horizonMocks.getAccountBalances.mockClear();
  vi.mocked(notifyOperatorFloatDrift).mockClear();
  vi.mocked(markWorkerTickSuccess).mockClear();
  vi.mocked(markWorkerTickFailure).mockClear();
});

const basePayment = (overrides: Partial<HorizonPayment> = {}): HorizonPayment => ({
  id: 'op-1',
  paging_token: 'pt-1',
  type: 'payment',
  from: 'GUSER',
  to: 'GOPERATOR',
  asset_type: 'native',
  amount: '1.5000000',
  transaction_hash: 'tx-1',
  transaction_successful: true,
  transaction: { memo_type: 'text', memo: 'memo-1', successful: true },
  ...overrides,
});

describe('operator float movement extraction', () => {
  it('extracts inbound native XLM movement involving the operator account', () => {
    const movement = extractOperatorMovement({
      payment: basePayment(),
      account: 'GOPERATOR',
      usdcIssuer: null,
    });

    expect(movement).toMatchObject({
      paymentId: 'op-1',
      asset: 'xlm',
      assetCode: 'XLM',
      direction: 'in',
      amountStroops: 15_000_000n,
      memoText: 'memo-1',
    });
  });

  it('extracts outbound configured USDC movement', () => {
    const movement = extractOperatorMovement({
      payment: basePayment({
        id: 'op-2',
        from: 'GOPERATOR',
        to: 'GCTX',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: 'GISSUER',
        amount: '12.3400000',
      }),
      account: 'GOPERATOR',
      usdcIssuer: 'GISSUER',
    });

    expect(movement).toMatchObject({
      paymentId: 'op-2',
      asset: 'usdc',
      assetCode: 'USDC',
      assetIssuer: 'GISSUER',
      direction: 'out',
      amountStroops: 123_400_000n,
    });
  });

  it('ignores non-configured USDC issuers and non-payment operations', () => {
    expect(
      extractOperatorMovement({
        payment: basePayment({
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: 'GOTHER',
        }),
        account: 'GOPERATOR',
        usdcIssuer: 'GISSUER',
      }),
    ).toBeNull();

    expect(
      extractOperatorMovement({
        payment: basePayment({ type: 'create_account' }),
        account: 'GOPERATOR',
        usdcIssuer: null,
      }),
    ).toBeNull();
  });

  // P2-g (2026-07-10): the vacuous-issuer shape #1601/#1607 fixed on
  // `isMatchingIncomingPayment` / `getAccountBalances` — a code-only
  // "USDC" match with NO configured issuer must never be classified as
  // a real USDC movement, since Stellar asset codes aren't unique and
  // an unconfigured issuer previously matched ANY self-issued "USDC".
  it('does NOT classify an any-issuer USDC payment as usdc when no issuer is configured (fail-closed)', () => {
    const movement = extractOperatorMovement({
      payment: basePayment({
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        // An arbitrary/attacker-controlled issuer — with no configured
        // `usdcIssuer`, this must be excluded, not matched.
        asset_issuer: 'GATTACKERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }),
      account: 'GOPERATOR',
      usdcIssuer: null,
    });

    expect(movement).toBeNull();
  });

  it('still classifies a matching-issuer USDC payment as usdc when the issuer IS configured', () => {
    const movement = extractOperatorMovement({
      payment: basePayment({
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: 'GISSUER',
      }),
      account: 'GOPERATOR',
      usdcIssuer: 'GISSUER',
    });

    expect(movement).toMatchObject({ asset: 'usdc', assetCode: 'USDC', assetIssuer: 'GISSUER' });
  });
});

describe('operator float reconciliation math', () => {
  it('adds opening balance, classified movement delta, and unlinked manual delta', () => {
    expect(
      computeExpectedBalance({
        openingBalanceStroops: 1000n,
        classifiedMovementDeltaStroops: -250n,
        unlinkedManualDeltaStroops: 75n,
      }),
    ).toBe(825n);
  });

  it('treats unclassified movement as degraded even when the balance delta is in band', () => {
    expect(classifyRun({ deltaStroops: 0n, thresholdStroops: 10n, unclassifiedCount: 1 })).toBe(
      'unclassified',
    );
  });

  it('uses threshold comparison for clean classified runs', () => {
    expect(classifyRun({ deltaStroops: 10n, thresholdStroops: 10n, unclassifiedCount: 0 })).toBe(
      'ok',
    );
    expect(classifyRun({ deltaStroops: -11n, thresholdStroops: 10n, unclassifiedCount: 0 })).toBe(
      'drift',
    );
  });

  it('uses fee-tolerant XLM and strict USDC defaults', () => {
    expect(thresholdForAsset('xlm')).toBe(10_000_000n);
    expect(thresholdForAsset('usdc')).toBe(1n);
  });
});

describe('reclassifyUnclassifiedMovements (F3/F4 heal pass)', () => {
  it('heals a deposit whose paying order appeared after indexing, and leaves truly unknown rows alone', async () => {
    // Two stuck rows: an inbound whose order NOW carries its paying id
    // (payment watcher lagged the indexer), and an outbound matching
    // nothing.
    stage('operator_wallet_movements', [
      { paymentId: 'op-in', txHash: 'tx-in', direction: 'in' },
      { paymentId: 'op-out', txHash: 'tx-out', direction: 'out' },
    ]);
    // classifyMovement(op-in): manual lookup → none, orders lookup → hit.
    stage('operator_manual_movements', []);
    stage('orders', [{ id: 'order-1' }]);
    // classifyMovement(op-out): manual → none, skips(refund) → none,
    // settlements → none → stays unclassified.
    stage('operator_manual_movements', []);
    stage('payment_watcher_skips', []);
    stage('ctx_settlements', []);

    const healed = await reclassifyUnclassifiedMovements({ account: 'GOPERATOR', asset: 'xlm' });

    expect(healed).toBe(1);
    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0]).toMatchObject({
      table: 'operator_wallet_movements',
      set: expect.objectContaining({ classification: 'user_deposit', orderId: 'order-1' }),
    });
  });

  it('heals a movement whose manual explanation raced the indexer (F4)', async () => {
    stage('operator_wallet_movements', [
      { paymentId: 'op-manual', txHash: 'tx-m', direction: 'out' },
    ]);
    stage('operator_manual_movements', [{ id: 'manual-1' }]);

    const healed = await reclassifyUnclassifiedMovements({ account: 'GOPERATOR', asset: 'usdc' });

    expect(healed).toBe(1);
    expect(dbState.updates[0]).toMatchObject({
      set: expect.objectContaining({ classification: 'manual', manualMovementId: 'manual-1' }),
    });
  });

  it('returns 0 and writes nothing when no rows are stuck', async () => {
    stage('operator_wallet_movements', []);
    await expect(
      reclassifyUnclassifiedMovements({ account: 'GOPERATOR', asset: 'xlm' }),
    ).resolves.toBe(0);
    expect(dbState.updates).toHaveLength(0);
  });
});

const baselineRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'b-1',
  asset: 'xlm',
  account: 'GOPERATOR',
  openingBalanceStroops: 1000n,
  startingHorizonCursor: 'c0',
  currentHorizonCursor: 'c0',
  active: 1,
  reason: 'test baseline',
  createdBy: 'ops',
  createdAt: new Date('2026-07-01T00:00:00Z'),
  updatedAt: new Date('2026-07-01T00:00:00Z'),
  ...over,
});

const RUN_ARGS = {
  account: 'GOPERATOR',
  asset: 'xlm' as const,
  usdcIssuer: null,
  thresholdStroops: 10n,
};

describe('runOperatorFloatReconciliationForAsset', () => {
  it('recomputes once before paging: a deposit landing in the index/balance-read window does not false-page', async () => {
    // Baseline loads: run start, pass-1 pin, pass-2 pin.
    stage('operator_wallet_baselines', [baselineRow()]);
    stage('operator_wallet_baselines', [baselineRow()]);
    stage('operator_wallet_baselines', [baselineRow()]);
    // Pass 1 reads a balance that looks drifted (the in-window
    // deposit); pass 2 sees the reconciled balance.
    horizonMocks.getAccountBalances
      .mockResolvedValueOnce({ xlmStroops: 999_999n, usdcStroops: 0n })
      .mockResolvedValueOnce({ xlmStroops: 1000n, usdcStroops: 0n });

    const summary = await runOperatorFloatReconciliationForAsset(RUN_ARGS);

    expect(summary.state).toBe('ok');
    expect(horizonMocks.getAccountBalances).toHaveBeenCalledTimes(2);
    // Exactly one run row persisted — pass 1's transient drift never
    // reaches the table or the pager.
    const runs = dbState.inserts.filter((i) => i.table === 'operator_float_reconciliation_runs');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.values).toMatchObject({ state: 'ok', deltaStroops: 0n });
    expect(notifyOperatorFloatDrift).not.toHaveBeenCalled();
  });

  it('pages when drift survives the recompute', async () => {
    stage('operator_wallet_baselines', [baselineRow()]);
    stage('operator_wallet_baselines', [baselineRow()]);
    stage('operator_wallet_baselines', [baselineRow()]);
    horizonMocks.getAccountBalances.mockResolvedValue({ xlmStroops: 999_999n, usdcStroops: 0n });

    const summary = await runOperatorFloatReconciliationForAsset(RUN_ARGS);

    expect(summary.state).toBe('drift');
    expect(notifyOperatorFloatDrift).toHaveBeenCalledTimes(1);
  });

  it('restarts cleanly against a NEW baseline when an operator re-baselines mid-run', async () => {
    // Run start pins b-1; pass 1 discovers b-2 became active → the
    // whole per-asset run restarts and reconciles against b-2 only —
    // no run record mixing b-1's opening balance with b-2's cursor.
    stage('operator_wallet_baselines', [baselineRow()]);
    stage('operator_wallet_baselines', [baselineRow({ id: 'b-2', openingBalanceStroops: 5000n })]);
    stage('operator_wallet_baselines', [baselineRow({ id: 'b-2', openingBalanceStroops: 5000n })]);
    stage('operator_wallet_baselines', [baselineRow({ id: 'b-2', openingBalanceStroops: 5000n })]);
    horizonMocks.getAccountBalances.mockResolvedValue({ xlmStroops: 5000n, usdcStroops: 0n });

    const summary = await runOperatorFloatReconciliationForAsset(RUN_ARGS);

    expect(summary).toMatchObject({ state: 'ok', baselineId: 'b-2' });
    const runs = dbState.inserts.filter((i) => i.table === 'operator_float_reconciliation_runs');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.values).toMatchObject({ baselineId: 'b-2', expectedBalanceStroops: 5000n });
    expect(notifyOperatorFloatDrift).not.toHaveBeenCalled();
  });
});

describe('cold start (no active baseline configured)', () => {
  it('fails closed to needs_baseline, touches NO Horizon endpoint, and pages ops', async () => {
    // No `stage('operator_wallet_baselines', …)` call — the FIFO is
    // empty, so `loadActiveBaseline` resolves undefined → null, the
    // same shape a genuinely empty table produces on a fresh
    // production DB before any operator has created a baseline.
    const summary = await runOperatorFloatReconciliationForAsset(RUN_ARGS);

    expect(summary.state).toBe('needs_baseline');
    expect(summary.error).toMatch(/baseline is not configured/);
    // The whole point of failing closed BEFORE indexing: a fresh
    // production deploy must not walk the account's full Horizon
    // history (or read a balance) just because nobody has anchored a
    // baseline yet.
    expect(horizonMocks.listAccountPayments).not.toHaveBeenCalled();
    expect(horizonMocks.getAccountBalances).not.toHaveBeenCalled();
    const runs = dbState.inserts.filter((i) => i.table === 'operator_float_reconciliation_runs');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.values).toMatchObject({ state: 'needs_baseline', baselineId: null });
    // Production readiness (2026-07-10): needs_baseline must page,
    // same as drift/unclassified — a silently-idle watcher is not a
    // healthy "nothing to report" signal, it means R3-1 is checking
    // nothing and an operator has not been prompted to fix that.
    expect(notifyOperatorFloatDrift).toHaveBeenCalledTimes(1);
    expect(notifyOperatorFloatDrift).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'needs_baseline' }),
    );
  });
});

describe('watcher tick health', () => {
  async function flushTick(): Promise<void> {
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
  }

  it('marks tick success when another machine holds the fleet lock', async () => {
    advisoryState.acquired = false;
    startOperatorFloatReconciliationWatcher({ intervalMs: 60_000 });
    try {
      await flushTick();
      expect(markWorkerTickSuccess).toHaveBeenCalledWith('operator_float_reconciliation');
      expect(markWorkerTickFailure).not.toHaveBeenCalled();
    } finally {
      stopOperatorFloatReconciliationWatcher();
    }
  });
});
