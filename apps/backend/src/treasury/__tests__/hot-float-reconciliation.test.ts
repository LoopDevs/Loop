import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';

/**
 * `treasury/hot-float-reconciliation.ts` (ADR 031 §D4, V5) — the
 * float/pool desync check (gap b). Proves: a normal single-driver
 * replenish (operator on-chain share balance settles to exactly what
 * the bookkeeping expects) reads 'ok' and does NOT false-page; a
 * genuine desync (operator holds FEWER shares than the bookkeeping
 * expects — the double-withdraw signature) reads 'drift' and pages
 * EVERY bad-state run (not fire-once); single-flighted fleet-wide.
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
      LOOP_VAULT_FLOAT_RECONCILIATION_INTERVAL_HOURS: 24,
      LOOP_VAULT_FLOAT_SHARES_THRESHOLD_STROOPS: 1_000_000n,
    },
    advisoryState: { acquired: true },
    dbState: state,
    dbMock: { insert },
    mocks: {
      vaultsEnabled: vi.fn<() => boolean>(() => true),
      listActiveVaults: vi.fn<(network: string) => Promise<unknown[]>>(async () => []),
      getShareBalance: vi.fn<(args: unknown) => Promise<bigint>>(async () => 0n),
      resolveOperatorPublicKey: vi.fn<() => string>(
        () => 'GOPERATORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      ),
      sumOperatorHeldEmissionShares: vi.fn<(a: string, n: string) => Promise<bigint>>(
        async () => 0n,
      ),
      sumOperatorHeldCollectedRedemptionShares: vi.fn<(a: string, n: string) => Promise<bigint>>(
        async () => 0n,
      ),
      getHotFloatRow: vi.fn<
        (a: string, n: string) => Promise<{ balanceMinor: bigint; pendingUnredeemedShares: bigint }>
      >(async () => ({ balanceMinor: 0n, pendingUnredeemedShares: 0n })),
      notifyVaultFloatDesync: vi.fn(async () => true),
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
vi.mock('../../credits/vaults/vault-client.js', () => ({
  getShareBalance: mocks.getShareBalance,
  resolveOperatorPublicKey: mocks.resolveOperatorPublicKey,
}));
vi.mock('../../credits/vaults/vault-share-accounting.js', () => ({
  sumOperatorHeldEmissionShares: mocks.sumOperatorHeldEmissionShares,
  sumOperatorHeldCollectedRedemptionShares: mocks.sumOperatorHeldCollectedRedemptionShares,
}));
vi.mock('../hot-float.js', () => ({ getHotFloatRow: mocks.getHotFloatRow }));
vi.mock('../../discord.js', () => ({ notifyVaultFloatDesync: mocks.notifyVaultFloatDesync }));

import { vaultFloatReconciliationRuns } from '../../db/schema.js';
import { runVaultFloatReconciliationTick } from '../hot-float-reconciliation.js';

dbState.tableNameOf = (t: unknown) => getTableName(t as Parameters<typeof getTableName>[0]);

const VAULT = {
  id: 'vault-1',
  assetCode: 'LOOPUSD',
  network: 'testnet',
  vaultContractId: 'CVAULT',
  shareAssetCode: 'LOOPUSD',
  shareAssetIssuer: 'CSHARE',
  underlyingAssetCode: 'USDC',
  underlyingAssetIssuer: 'GUSDC',
  strategyId: 'blend-usdc-pool',
  feeBps: 5000,
  active: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

beforeEach(() => {
  advisoryState.acquired = true;
  dbState.inserts = [];
  mocks.vaultsEnabled.mockReturnValue(true);
  mocks.listActiveVaults.mockReset();
  mocks.listActiveVaults.mockResolvedValue([]);
  mocks.getShareBalance.mockReset();
  mocks.getShareBalance.mockResolvedValue(0n);
  mocks.sumOperatorHeldEmissionShares.mockReset();
  mocks.sumOperatorHeldEmissionShares.mockResolvedValue(0n);
  mocks.sumOperatorHeldCollectedRedemptionShares.mockReset();
  mocks.sumOperatorHeldCollectedRedemptionShares.mockResolvedValue(0n);
  mocks.getHotFloatRow.mockReset();
  mocks.getHotFloatRow.mockResolvedValue({ balanceMinor: 0n, pendingUnredeemedShares: 0n });
  mocks.notifyVaultFloatDesync.mockReset();
  mocks.notifyVaultFloatDesync.mockResolvedValue(true);
});

describe('runVaultFloatReconciliationTick', () => {
  it('reads ok and does not page when the operator on-chain share balance matches the COMPLETE bookkeeping (all three buckets)', async () => {
    mocks.listActiveVaults.mockResolvedValue([VAULT]);
    // Complete in-flight state: emission-held (bucket 2) = 300,
    // redemption collected-not-paid (bucket 3) = 200, hot-float
    // pending (bucket 4) = 500 → the operator's real on-chain balance
    // should be exactly their sum (1000).
    mocks.sumOperatorHeldEmissionShares.mockResolvedValue(300n);
    mocks.sumOperatorHeldCollectedRedemptionShares.mockResolvedValue(200n);
    mocks.getHotFloatRow.mockResolvedValue({ balanceMinor: 0n, pendingUnredeemedShares: 500n });
    mocks.getShareBalance.mockResolvedValue(1_000n);

    const r = await runVaultFloatReconciliationTick();
    expect(r.samples[0]?.state).toBe('ok');
    expect(r.samples[0]?.expectedOperatorShares).toBe(1_000n);
    expect(r.samples[0]?.shareDelta).toBe(0n);
    expect(mocks.notifyVaultFloatDesync).not.toHaveBeenCalled();
    expect(dbState.inserts[0]?.table).toBe(getTableName(vaultFloatReconciliationRuns));
    expect(dbState.inserts[0]?.values['state']).toBe('ok');
  });

  it('does not false-page when a collected-not-paid redemption (bucket 3) is what the operator holds — the pre-fix blind spot', async () => {
    // The operator holds 250 shares from a redemption that collected
    // but hasn't run any payout (bucket 3). The OLD expected sum
    // (deposited + pending only) omitted this, reading a spurious +250
    // drift. With bucket (3) counted, it balances.
    mocks.listActiveVaults.mockResolvedValue([VAULT]);
    mocks.sumOperatorHeldEmissionShares.mockResolvedValue(0n);
    mocks.sumOperatorHeldCollectedRedemptionShares.mockResolvedValue(250n);
    mocks.getHotFloatRow.mockResolvedValue({ balanceMinor: 0n, pendingUnredeemedShares: 0n });
    mocks.getShareBalance.mockResolvedValue(250n);

    const r = await runVaultFloatReconciliationTick();
    expect(r.samples[0]?.state).toBe('ok');
    expect(mocks.notifyVaultFloatDesync).not.toHaveBeenCalled();
  });

  it('does not false-page on a normal vault withdraw inflow (float credited, pending shares decremented, still balances)', async () => {
    mocks.listActiveVaults.mockResolvedValue([VAULT]);
    mocks.getHotFloatRow.mockResolvedValue({ balanceMinor: 500_000n, pendingUnredeemedShares: 0n });
    mocks.getShareBalance.mockResolvedValue(0n);

    const r = await runVaultFloatReconciliationTick();
    expect(r.samples[0]?.state).toBe('ok');
    expect(mocks.notifyVaultFloatDesync).not.toHaveBeenCalled();
  });

  it('detects a genuine desync: operator holds FEWER shares than the bookkeeping expects (double-withdraw signature)', async () => {
    mocks.listActiveVaults.mockResolvedValue([VAULT]);
    // Bookkeeping thinks 5_000_000 shares (stroops) are pending unredeemed...
    mocks.getHotFloatRow.mockResolvedValue({
      balanceMinor: 0n,
      pendingUnredeemedShares: 5_000_000n,
    });
    // ...but a double-withdraw race already burned 4_000_000 of them without decrementing the counter — well past the 1_000_000 threshold. Stable across the recompute, so it persists as a real desync.
    mocks.getShareBalance.mockResolvedValue(1_000_000n);

    const r = await runVaultFloatReconciliationTick();
    const sample = r.samples[0];
    expect(sample?.state).toBe('drift');
    expect(sample?.shareDelta).toBe(-4_000_000n);
    expect(mocks.notifyVaultFloatDesync).toHaveBeenCalledTimes(1);
    expect(dbState.inserts[0]?.values['state']).toBe('drift');
  });

  it('recompute-before-page clears a one-run TOCTOU blip: first pass drifts, second pass consistent → no page', async () => {
    mocks.listActiveVaults.mockResolvedValue([VAULT]);
    mocks.getHotFloatRow.mockResolvedValue({
      balanceMinor: 0n,
      pendingUnredeemedShares: 5_000_000n,
    });
    // First on-chain read catches an in-flight op mid-commit (looks
    // like a 4M shortfall); the recompute a moment later — after the
    // op's DB row committed — reads consistent.
    mocks.getShareBalance
      .mockResolvedValueOnce(1_000_000n) // first pass → drift
      .mockResolvedValue(5_000_000n); // recompute → consistent

    const r = await runVaultFloatReconciliationTick();
    expect(r.samples[0]?.state).toBe('ok');
    expect(mocks.notifyVaultFloatDesync).not.toHaveBeenCalled();
    // Proves the recompute actually ran (two on-chain reads for one vault).
    expect(mocks.getShareBalance).toHaveBeenCalledTimes(2);
  });

  it('pages on every bad-state run, not fire-once (two consecutive drifting ticks both page)', async () => {
    mocks.listActiveVaults.mockResolvedValue([VAULT]);
    mocks.getHotFloatRow.mockResolvedValue({
      balanceMinor: 0n,
      pendingUnredeemedShares: 5_000_000n,
    });
    mocks.getShareBalance.mockResolvedValue(1_000_000n);

    await runVaultFloatReconciliationTick();
    await runVaultFloatReconciliationTick();
    expect(mocks.notifyVaultFloatDesync).toHaveBeenCalledTimes(2);
  });

  it('persists state=error and pages when a Soroban/DB read fails, without throwing', async () => {
    mocks.listActiveVaults.mockResolvedValue([VAULT]);
    mocks.getShareBalance.mockRejectedValue(new Error('RPC timeout'));

    const r = await runVaultFloatReconciliationTick();
    expect(r.samples[0]?.state).toBe('error');
    expect(mocks.notifyVaultFloatDesync).toHaveBeenCalledTimes(1);
    expect(dbState.inserts[0]?.values['state']).toBe('error');
  });

  it('no-ops when the vault subsystem is disabled', async () => {
    mocks.vaultsEnabled.mockReturnValue(false);
    mocks.listActiveVaults.mockResolvedValue([VAULT]);
    const r = await runVaultFloatReconciliationTick();
    expect(r.samples).toHaveLength(0);
    expect(mocks.listActiveVaults).not.toHaveBeenCalled();
  });

  it('is single-flighted fleet-wide: skips when another machine holds the lock', async () => {
    advisoryState.acquired = false;
    mocks.listActiveVaults.mockResolvedValue([VAULT]);
    const r = await runVaultFloatReconciliationTick();
    expect(r.skippedLocked).toBe(true);
    expect(mocks.listActiveVaults).not.toHaveBeenCalled();
  });
});
