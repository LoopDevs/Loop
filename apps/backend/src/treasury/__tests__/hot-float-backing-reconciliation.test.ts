import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';

/**
 * NS-06 — `treasury/hot-float-backing-reconciliation.ts`. Proves the
 * drift detection: a recorded hot-float balance MATCHED by on-chain USDC
 * reads `ok` and does NOT page; a commingled SURPLUS (on-chain USDC far
 * exceeds the recorded float — the normal state) also reads `ok`
 * (one-directional check); a genuine SHORTFALL beyond threshold (recorded
 * float exceeds real on-chain USDC — unbacked) reads `drift` and pages on
 * EVERY bad-state run; carry_stroops is included exactly; unreadable
 * on-chain USDC / a thrown read persist `error` and page; single-flighted
 * fleet-wide; gated on the vault subsystem + a USDC-backed vault.
 */

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { mutableEnv, mocks, advisoryState, dbState, dbMock } = vi.hoisted(() => {
  const state = {
    inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
    tableNameOf: (_t: unknown): string => '',
  };
  const insert = (table: unknown): unknown => ({
    values: async (v: Record<string, unknown>) => {
      state.inserts.push({ table: state.tableNameOf(table), values: v });
    },
  });
  return {
    mutableEnv: {
      LOOP_STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
      LOOP_HOT_FLOAT_BACKING_RECONCILIATION_INTERVAL_HOURS: 24,
      LOOP_HOT_FLOAT_BACKING_THRESHOLD_STROOPS: 100_000_000n,
      LOOP_STELLAR_DEPOSIT_ADDRESS: 'GOPERATORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      LOOP_STELLAR_USDC_ISSUER: 'GUSDCISSUER',
    } as Record<string, unknown>,
    advisoryState: { acquired: true },
    dbState: state,
    dbMock: { insert },
    mocks: {
      vaultsEnabled: vi.fn<() => boolean>(() => true),
      listActiveVaults: vi.fn<(network: string) => Promise<unknown[]>>(async () => []),
      getAccountBalances: vi.fn<
        (account: string, issuer: string | null) => Promise<{ usdcStroops: bigint | null }>
      >(async () => ({ usdcStroops: 0n })),
      getHotFloatRow: vi.fn<
        (
          a: string,
          n: string,
        ) => Promise<{
          balanceMinor: bigint;
          carryStroops: bigint;
          pendingUnredeemedShares: bigint;
        }>
      >(async () => ({ balanceMinor: 0n, carryStroops: 0n, pendingUnredeemedShares: 0n })),
      notifyHotFloatBackingShortfall: vi.fn(async () => true),
      setMoneyIntegrityBreach: vi.fn(),
      markWorkerStarted: vi.fn(),
      markWorkerStopped: vi.fn(),
      markWorkerTickSuccess: vi.fn(),
      markWorkerTickFailure: vi.fn(),
    },
  };
});

vi.mock('../../env.js', () => ({ env: mutableEnv }));
vi.mock('../../db/client.js', () => ({
  db: dbMock,
  withAdvisoryLock: async <T>(
    _key: bigint,
    fn: () => Promise<T>,
  ): Promise<{ ran: true; value: T } | { ran: false }> =>
    advisoryState.acquired ? { ran: true, value: await fn() } : { ran: false },
}));
vi.mock('../../credits/vaults/registry.js', () => ({
  vaultsEnabled: mocks.vaultsEnabled,
  listActiveVaults: mocks.listActiveVaults,
}));
vi.mock('../../payments/horizon-balances.js', () => ({
  getAccountBalances: mocks.getAccountBalances,
}));
vi.mock('../hot-float.js', () => ({ getHotFloatRow: mocks.getHotFloatRow }));
vi.mock('../../discord.js', () => ({
  notifyHotFloatBackingShortfall: mocks.notifyHotFloatBackingShortfall,
}));
vi.mock('../../metrics.js', () => ({ setMoneyIntegrityBreach: mocks.setMoneyIntegrityBreach }));
vi.mock('../../runtime-health.js', () => ({
  markWorkerStarted: mocks.markWorkerStarted,
  markWorkerStopped: mocks.markWorkerStopped,
  markWorkerTickSuccess: mocks.markWorkerTickSuccess,
  markWorkerTickFailure: mocks.markWorkerTickFailure,
}));

import { hotFloatBackingRuns } from '../../db/schema.js';
import {
  classifyHotFloatBacking,
  runHotFloatBackingReconciliationTick,
  startHotFloatBackingReconciliationWatcher,
  stopHotFloatBackingReconciliationWatcher,
} from '../hot-float-backing-reconciliation.js';

dbState.tableNameOf = (t: unknown) => getTableName(t as Parameters<typeof getTableName>[0]);

const USDC_VAULT = {
  id: 'vault-usd',
  assetCode: 'LOOPUSD',
  network: 'testnet',
  vaultContractId: 'CVAULTUSD',
  shareAssetCode: 'LOOPUSD',
  shareAssetIssuer: 'CSHAREUSD',
  underlyingAssetCode: 'USDC',
  underlyingAssetIssuer: 'GUSDCISSUER',
  strategyId: 'blend-usdc-pool',
  feeBps: 5000,
  active: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

const EUR_VAULT = {
  ...USDC_VAULT,
  id: 'vault-eur',
  assetCode: 'LOOPEUR',
  underlyingAssetCode: 'EURC',
  underlyingAssetIssuer: 'GEURCISSUER',
};

const RUNS_TABLE = getTableName(hotFloatBackingRuns);

beforeEach(() => {
  advisoryState.acquired = true;
  dbState.inserts = [];
  mutableEnv['LOOP_STELLAR_DEPOSIT_ADDRESS'] =
    'GOPERATORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  mutableEnv['LOOP_STELLAR_USDC_ISSUER'] = 'GUSDCISSUER';
  mocks.vaultsEnabled.mockReturnValue(true);
  mocks.listActiveVaults.mockReset();
  mocks.listActiveVaults.mockResolvedValue([]);
  mocks.getAccountBalances.mockReset();
  mocks.getAccountBalances.mockResolvedValue({ usdcStroops: 0n });
  mocks.getHotFloatRow.mockReset();
  mocks.getHotFloatRow.mockResolvedValue({
    balanceMinor: 0n,
    carryStroops: 0n,
    pendingUnredeemedShares: 0n,
  });
  mocks.notifyHotFloatBackingShortfall.mockReset();
  mocks.notifyHotFloatBackingShortfall.mockResolvedValue(true);
  mocks.setMoneyIntegrityBreach.mockClear();
  mocks.markWorkerStarted.mockClear();
  mocks.markWorkerStopped.mockClear();
  mocks.markWorkerTickSuccess.mockClear();
  mocks.markWorkerTickFailure.mockClear();
});

describe('classifyHotFloatBacking (one-directional shortfall)', () => {
  it('is ok on an exact match', () => {
    expect(classifyHotFloatBacking({ shortfallStroops: 0n, thresholdStroops: 100n })).toBe('ok');
  });
  it('is ok on any surplus (recorded < onchain) — the commingled normal state', () => {
    expect(
      classifyHotFloatBacking({ shortfallStroops: -5_000_000_000n, thresholdStroops: 100n }),
    ).toBe('ok');
  });
  it('is ok at exactly the threshold (boundary), drift one past it', () => {
    expect(classifyHotFloatBacking({ shortfallStroops: 100n, thresholdStroops: 100n })).toBe('ok');
    expect(classifyHotFloatBacking({ shortfallStroops: 101n, thresholdStroops: 100n })).toBe(
      'drift',
    );
  });
});

describe('runHotFloatBackingReconciliationTick', () => {
  it('reads ok and does not page when the recorded float matches on-chain USDC', async () => {
    mocks.listActiveVaults.mockResolvedValue([USDC_VAULT]);
    // 50 USDC recorded = 5_000_000 stroops; on-chain holds exactly that.
    mocks.getHotFloatRow.mockResolvedValue({
      balanceMinor: 50n,
      carryStroops: 0n,
      pendingUnredeemedShares: 0n,
    });
    mocks.getAccountBalances.mockResolvedValue({ usdcStroops: 5_000_000n });

    const r = await runHotFloatBackingReconciliationTick();
    expect(r.sample?.state).toBe('ok');
    expect(r.sample?.recordedFloatStroops).toBe(5_000_000n);
    expect(r.sample?.shortfallStroops).toBe(0n);
    expect(mocks.notifyHotFloatBackingShortfall).not.toHaveBeenCalled();
    expect(dbState.inserts[0]?.table).toBe(RUNS_TABLE);
    expect(dbState.inserts[0]?.values['state']).toBe('ok');
  });

  it('does NOT page on a commingled surplus (on-chain USDC far exceeds the recorded float)', async () => {
    mocks.listActiveVaults.mockResolvedValue([USDC_VAULT]);
    // Recorded 50 USDC; account also holds a big user-deposit pile.
    mocks.getHotFloatRow.mockResolvedValue({
      balanceMinor: 50n,
      carryStroops: 0n,
      pendingUnredeemedShares: 0n,
    });
    mocks.getAccountBalances.mockResolvedValue({ usdcStroops: 9_999_999_999n });

    const r = await runHotFloatBackingReconciliationTick();
    expect(r.sample?.state).toBe('ok');
    expect(r.sample?.shortfallStroops).toBeLessThan(0n);
    expect(mocks.notifyHotFloatBackingShortfall).not.toHaveBeenCalled();
  });

  it('includes carry_stroops in the recorded figure (exactness)', async () => {
    mocks.listActiveVaults.mockResolvedValue([USDC_VAULT]);
    // 50 USDC + 12345 carry stroops = 5_012_345 recorded.
    mocks.getHotFloatRow.mockResolvedValue({
      balanceMinor: 50n,
      carryStroops: 12_345n,
      pendingUnredeemedShares: 0n,
    });
    mocks.getAccountBalances.mockResolvedValue({ usdcStroops: 5_012_345n });

    const r = await runHotFloatBackingReconciliationTick();
    expect(r.sample?.recordedFloatStroops).toBe(5_012_345n);
    expect(r.sample?.state).toBe('ok');
  });

  it('sums the recorded float across multiple USDC-backed vaults, ignoring an EURC vault', async () => {
    mocks.listActiveVaults.mockResolvedValue([USDC_VAULT, EUR_VAULT]);
    // Only the USDC vault is reconciled; getHotFloatRow is called once
    // per USDC vault. Return 30 USDC for it.
    mocks.getHotFloatRow.mockResolvedValue({
      balanceMinor: 30n,
      carryStroops: 0n,
      pendingUnredeemedShares: 0n,
    });
    mocks.getAccountBalances.mockResolvedValue({ usdcStroops: 3_000_000n });

    const r = await runHotFloatBackingReconciliationTick();
    expect(r.sample?.state).toBe('ok');
    expect(r.sample?.underlyingAssetCode).toBe('USDC');
    // Only the USDC vault's float row was read (EURC skipped).
    expect(mocks.getHotFloatRow).toHaveBeenCalledTimes(1);
  });

  it('detects a genuine shortfall: recorded float exceeds on-chain USDC beyond threshold → drift + page', async () => {
    mocks.listActiveVaults.mockResolvedValue([USDC_VAULT]);
    // Recorded 5000 USDC (5e8 stroops) but the account only holds 100 USDC
    // (1e7) — a 4.9e8-stroop shortfall, well past the 1e8 threshold.
    mocks.getHotFloatRow.mockResolvedValue({
      balanceMinor: 5_000n,
      carryStroops: 0n,
      pendingUnredeemedShares: 0n,
    });
    mocks.getAccountBalances.mockResolvedValue({ usdcStroops: 10_000_000n });

    const r = await runHotFloatBackingReconciliationTick();
    expect(r.sample?.state).toBe('drift');
    // 500_000_000 recorded − 10_000_000 held = 490_000_000 shortfall.
    expect(r.sample?.shortfallStroops).toBe(490_000_000n);
    expect(mocks.notifyHotFloatBackingShortfall).toHaveBeenCalledTimes(1);
    expect(dbState.inserts[0]?.values['state']).toBe('drift');
  });

  it('does not drift on a shortfall within threshold', async () => {
    mocks.listActiveVaults.mockResolvedValue([USDC_VAULT]);
    // Recorded 1000 USDC (1e8), held 999.5 USDC (99_950_000) → 50_000
    // shortfall, under the 1e8 threshold.
    mocks.getHotFloatRow.mockResolvedValue({
      balanceMinor: 1_000n,
      carryStroops: 0n,
      pendingUnredeemedShares: 0n,
    });
    mocks.getAccountBalances.mockResolvedValue({ usdcStroops: 99_950_000n });

    const r = await runHotFloatBackingReconciliationTick();
    expect(r.sample?.state).toBe('ok');
    expect(mocks.notifyHotFloatBackingShortfall).not.toHaveBeenCalled();
  });

  it('recompute-before-page clears a one-run blip: first pass shortfall, second pass consistent → no page', async () => {
    mocks.listActiveVaults.mockResolvedValue([USDC_VAULT]);
    mocks.getHotFloatRow.mockResolvedValue({
      balanceMinor: 5_000n,
      carryStroops: 0n,
      pendingUnredeemedShares: 0n,
    });
    // First balance read catches an in-flight settlement (looks short);
    // the recompute a moment later reads the settled, matching balance.
    mocks.getAccountBalances
      .mockResolvedValueOnce({ usdcStroops: 10_000_000n }) // pass 1 → drift
      .mockResolvedValue({ usdcStroops: 500_000_000n }); // recompute → ok

    const r = await runHotFloatBackingReconciliationTick();
    expect(r.sample?.state).toBe('ok');
    expect(mocks.notifyHotFloatBackingShortfall).not.toHaveBeenCalled();
    expect(mocks.getAccountBalances).toHaveBeenCalledTimes(2);
  });

  it('pages on every bad-state run, not fire-once (two consecutive drifting ticks both page)', async () => {
    mocks.listActiveVaults.mockResolvedValue([USDC_VAULT]);
    mocks.getHotFloatRow.mockResolvedValue({
      balanceMinor: 5_000n,
      carryStroops: 0n,
      pendingUnredeemedShares: 0n,
    });
    mocks.getAccountBalances.mockResolvedValue({ usdcStroops: 10_000_000n });

    await runHotFloatBackingReconciliationTick();
    await runHotFloatBackingReconciliationTick();
    expect(mocks.notifyHotFloatBackingShortfall).toHaveBeenCalledTimes(2);
  });

  it('persists state=error and pages when on-chain USDC is unreadable (null)', async () => {
    mocks.listActiveVaults.mockResolvedValue([USDC_VAULT]);
    mocks.getHotFloatRow.mockResolvedValue({
      balanceMinor: 50n,
      carryStroops: 0n,
      pendingUnredeemedShares: 0n,
    });
    // No USDC trustline / issuer mismatch → null.
    mocks.getAccountBalances.mockResolvedValue({ usdcStroops: null });

    const r = await runHotFloatBackingReconciliationTick();
    expect(r.sample?.state).toBe('error');
    expect(mocks.notifyHotFloatBackingShortfall).toHaveBeenCalledTimes(1);
    expect(dbState.inserts[0]?.values['state']).toBe('error');
    expect(dbState.inserts[0]?.values['recordedFloatStroops']).toBeNull();
  });

  it('persists state=error and pages when a balance read throws, without throwing', async () => {
    mocks.listActiveVaults.mockResolvedValue([USDC_VAULT]);
    mocks.getAccountBalances.mockRejectedValue(new Error('Horizon 503'));

    const r = await runHotFloatBackingReconciliationTick();
    expect(r.sample?.state).toBe('error');
    expect(mocks.notifyHotFloatBackingShortfall).toHaveBeenCalledTimes(1);
    expect(dbState.inserts[0]?.values['state']).toBe('error');
  });

  it('no-ops (no sample) when the vault subsystem is disabled', async () => {
    mocks.vaultsEnabled.mockReturnValue(false);
    mocks.listActiveVaults.mockResolvedValue([USDC_VAULT]);
    const r = await runHotFloatBackingReconciliationTick();
    expect(r.sample).toBeNull();
    expect(mocks.listActiveVaults).not.toHaveBeenCalled();
  });

  it('no-ops (no sample) when there is no USDC-backed vault (only EURC)', async () => {
    mocks.listActiveVaults.mockResolvedValue([EUR_VAULT]);
    const r = await runHotFloatBackingReconciliationTick();
    expect(r.sample).toBeNull();
    expect(mocks.getAccountBalances).not.toHaveBeenCalled();
    expect(dbState.inserts).toHaveLength(0);
  });

  it('no-ops (no sample) when the deposit address is unconfigured', async () => {
    mocks.listActiveVaults.mockResolvedValue([USDC_VAULT]);
    mutableEnv['LOOP_STELLAR_DEPOSIT_ADDRESS'] = undefined;
    const r = await runHotFloatBackingReconciliationTick();
    expect(r.sample).toBeNull();
    expect(mocks.getAccountBalances).not.toHaveBeenCalled();
  });

  it('is single-flighted fleet-wide: skips when another machine holds the lock', async () => {
    advisoryState.acquired = false;
    mocks.listActiveVaults.mockResolvedValue([USDC_VAULT]);
    const r = await runHotFloatBackingReconciliationTick();
    expect(r.skippedLocked).toBe(true);
    expect(mocks.listActiveVaults).not.toHaveBeenCalled();
  });
});

describe('watcher tick health + money-integrity gauge', () => {
  async function flushTick(): Promise<void> {
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
  }

  it('records the standing shortfall on the money-integrity gauge and marks tick success', async () => {
    mocks.listActiveVaults.mockResolvedValue([USDC_VAULT]);
    mocks.getHotFloatRow.mockResolvedValue({
      balanceMinor: 5_000n,
      carryStroops: 0n,
      pendingUnredeemedShares: 0n,
    });
    mocks.getAccountBalances.mockResolvedValue({ usdcStroops: 10_000_000n });

    startHotFloatBackingReconciliationWatcher({ intervalMs: 60_000 });
    try {
      await flushTick();
      expect(mocks.setMoneyIntegrityBreach).toHaveBeenCalledWith('hot_float_backing', true);
      expect(mocks.markWorkerTickSuccess).toHaveBeenCalledWith('hot_float_backing_reconciliation');
      expect(mocks.markWorkerTickFailure).not.toHaveBeenCalled();
    } finally {
      stopHotFloatBackingReconciliationWatcher();
    }
  });

  it('marks tick success when another machine holds the fleet lock', async () => {
    advisoryState.acquired = false;
    startHotFloatBackingReconciliationWatcher({ intervalMs: 60_000 });
    try {
      await flushTick();
      expect(mocks.markWorkerTickSuccess).toHaveBeenCalledWith('hot_float_backing_reconciliation');
      // A lock-skip must not touch the gauge (sample === null).
      expect(mocks.setMoneyIntegrityBreach).not.toHaveBeenCalled();
    } finally {
      stopHotFloatBackingReconciliationWatcher();
    }
  });
});
