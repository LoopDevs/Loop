import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `vault-drift-watcher.ts` (ADR 031 §D4, V5) — INV-V1 (no unbacked
 * shares) + INV-V2 (redemption solvency). Mocks the V2 Soroban client
 * (`readVaultState` / `getShareBalance` / `resolveOperatorPublicKey`),
 * the V1 registry (`listActiveVaults` / `vaultsEnabled`), the V5
 * share-accounting sums, the hot-float row read, and
 * `applyBinaryWatchdogAlert` (its own correctness is proven by
 * `vault-watchdog-alert.test.ts` — this suite proves the WATCHER calls
 * it with the right `shouldBeActive` / threshold-derived decisions).
 * No network, no real DB.
 */

vi.mock('../../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { mutableEnv, mocks, advisoryState } = vi.hoisted(() => {
  return {
    mutableEnv: {
      LOOP_STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
      LOOP_VAULT_DRIFT_WATCHER_INTERVAL_SECONDS: 300,
      LOOP_VAULT_DRIFT_SHARES_THRESHOLD_STROOPS: 100_000_000n,
      LOOP_VAULT_DRIFT_SOLVENCY_THRESHOLD_STROOPS: 100_000_000n,
    },
    advisoryState: { acquired: true },
    mocks: {
      vaultsEnabled: vi.fn<() => boolean>(() => true),
      listActiveVaults: vi.fn<(network: string) => Promise<unknown[]>>(async () => []),
      readVaultState: vi.fn<
        (
          args: unknown,
        ) => Promise<{ totalSupply: bigint; totalManaged: bigint; sharePricePpm: bigint }>
      >(async () => ({ totalSupply: 0n, totalManaged: 0n, sharePricePpm: 1_000_000n })),
      getShareBalance: vi.fn<(args: unknown) => Promise<bigint>>(async () => 0n),
      resolveOperatorPublicKey: vi.fn<() => string>(
        () => 'GOPERATORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      ),
      sumOffChainNetUserShares: vi.fn<(a: string, n: string) => Promise<bigint>>(async () => 0n),
      sumVaultMirrorLiabilityMinor: vi.fn<(a: string, n: string) => Promise<bigint>>(
        async () => 0n,
      ),
      getHotFloatRow: vi.fn<(a: string, n: string) => Promise<{ balanceMinor: bigint }>>(
        async () => ({ balanceMinor: 0n }),
      ),
      applyBinaryWatchdogAlert: vi.fn<(args: { shouldBeActive: boolean }) => Promise<boolean>>(
        async (args) => args.shouldBeActive,
      ),
      notifyVaultShareDrift: vi.fn(async () => true),
      notifyVaultShareDriftRecovered: vi.fn(async () => true),
      notifyVaultSolvencyBreach: vi.fn(async () => true),
      notifyVaultSolvencyRecovered: vi.fn(async () => true),
    },
  };
});

vi.mock('../../../env.js', () => ({ env: mutableEnv }));
vi.mock('../registry.js', () => ({
  vaultsEnabled: mocks.vaultsEnabled,
  listActiveVaults: mocks.listActiveVaults,
}));
vi.mock('../vault-client.js', () => ({
  readVaultState: mocks.readVaultState,
  getShareBalance: mocks.getShareBalance,
  resolveOperatorPublicKey: mocks.resolveOperatorPublicKey,
}));
vi.mock('../vault-share-accounting.js', () => ({
  sumOffChainNetUserShares: mocks.sumOffChainNetUserShares,
  sumVaultMirrorLiabilityMinor: mocks.sumVaultMirrorLiabilityMinor,
}));
vi.mock('../../../treasury/hot-float.js', () => ({ getHotFloatRow: mocks.getHotFloatRow }));
vi.mock('../vault-watchdog-alert.js', () => ({
  applyBinaryWatchdogAlert: mocks.applyBinaryWatchdogAlert,
}));
vi.mock('../../../discord.js', () => ({
  notifyVaultShareDrift: mocks.notifyVaultShareDrift,
  notifyVaultShareDriftRecovered: mocks.notifyVaultShareDriftRecovered,
  notifyVaultSolvencyBreach: mocks.notifyVaultSolvencyBreach,
  notifyVaultSolvencyRecovered: mocks.notifyVaultSolvencyRecovered,
}));
vi.mock('../../../db/client.js', () => ({
  withAdvisoryLock: async <T>(
    _key: bigint,
    fn: () => Promise<T>,
  ): Promise<{ ran: true; value: T } | { ran: false }> =>
    advisoryState.acquired ? { ran: true, value: await fn() } : { ran: false },
}));

import { runVaultDriftTick } from '../vault-drift-watcher.js';

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

const ARGS = { sharesThreshold: 100_000_000n, solvencyThresholdStroops: 100_000_000n };

beforeEach(() => {
  advisoryState.acquired = true;
  mocks.vaultsEnabled.mockReturnValue(true);
  mocks.listActiveVaults.mockReset();
  mocks.listActiveVaults.mockResolvedValue([]);
  mocks.readVaultState.mockReset();
  mocks.readVaultState.mockResolvedValue({
    totalSupply: 0n,
    totalManaged: 0n,
    sharePricePpm: 1_000_000n,
  });
  mocks.getShareBalance.mockReset();
  mocks.getShareBalance.mockResolvedValue(0n);
  mocks.sumOffChainNetUserShares.mockReset();
  mocks.sumOffChainNetUserShares.mockResolvedValue(0n);
  mocks.sumVaultMirrorLiabilityMinor.mockReset();
  mocks.sumVaultMirrorLiabilityMinor.mockResolvedValue(0n);
  mocks.getHotFloatRow.mockReset();
  mocks.getHotFloatRow.mockResolvedValue({ balanceMinor: 0n });
  mocks.applyBinaryWatchdogAlert.mockReset();
  mocks.applyBinaryWatchdogAlert.mockImplementation(async (args: { shouldBeActive: boolean }) =>
    Boolean(args.shouldBeActive),
  );
});

describe('runVaultDriftTick', () => {
  it('returns empty result when the vault subsystem is disabled', async () => {
    mocks.vaultsEnabled.mockReturnValue(false);
    mocks.listActiveVaults.mockResolvedValue([VAULT]);
    const r = await runVaultDriftTick(ARGS);
    expect(r.checked).toBe(0);
    expect(mocks.listActiveVaults).not.toHaveBeenCalled();
  });

  it('no-pages when on-chain and off-chain shares agree and solvency holds', async () => {
    mocks.listActiveVaults.mockResolvedValue([VAULT]);
    mocks.readVaultState.mockResolvedValue({
      totalSupply: 1_000_000_000n,
      totalManaged: 1_050_000_000n,
      sharePricePpm: 1_050_000n,
    });
    mocks.getShareBalance.mockResolvedValue(0n); // operator holds nothing — all shares with users
    mocks.sumOffChainNetUserShares.mockResolvedValue(1_000_000_000n); // matches totalSupply exactly

    const r = await runVaultDriftTick(ARGS);
    expect(r.checked).toBe(1);
    const sample = r.samples[0];
    expect(sample?.sharesOver).toBe(false);
    expect(sample?.solvencyOver).toBe(false);
    expect(sample?.notified).toBe(false);
    expect(mocks.notifyVaultShareDrift).not.toHaveBeenCalled();
    expect(mocks.notifyVaultSolvencyBreach).not.toHaveBeenCalled();
  });

  it('pages INV-V1 when on-chain user shares drift from the off-chain tracked total past threshold', async () => {
    mocks.listActiveVaults.mockResolvedValue([VAULT]);
    mocks.readVaultState.mockResolvedValue({
      totalSupply: 1_000_000_000n,
      totalManaged: 1_000_000_000n,
      sharePricePpm: 1_000_000n,
    });
    mocks.getShareBalance.mockResolvedValue(0n);
    // Off-chain thinks users hold 200_000_000 shares LESS than on-chain reality.
    mocks.sumOffChainNetUserShares.mockResolvedValue(800_000_000n);

    const r = await runVaultDriftTick(ARGS);
    const sample = r.samples[0];
    expect(sample?.sharesOver).toBe(true);
    expect(sample?.sharesDrift).toBe(200_000_000n);
    expect(sample?.notified).toBe(true);
    expect(mocks.applyBinaryWatchdogAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        watchdogName: 'vault-drift-shares:LOOPUSD:testnet',
        shouldBeActive: true,
      }),
    );
  });

  it('does not page INV-V1 for a drift within threshold', async () => {
    mocks.listActiveVaults.mockResolvedValue([VAULT]);
    mocks.readVaultState.mockResolvedValue({
      totalSupply: 1_000_000_000n,
      totalManaged: 1_000_000_000n,
      sharePricePpm: 1_000_000n,
    });
    mocks.getShareBalance.mockResolvedValue(0n);
    mocks.sumOffChainNetUserShares.mockResolvedValue(999_999_990n); // 10 stroops of drift, well under 1e8 threshold

    const r = await runVaultDriftTick(ARGS);
    expect(r.samples[0]?.sharesOver).toBe(false);
    expect(mocks.notifyVaultShareDrift).not.toHaveBeenCalled();
  });

  it('pages INV-V2 when the off-chain USD mirror liability exceeds redeemable backing + hot float past threshold', async () => {
    mocks.listActiveVaults.mockResolvedValue([VAULT]);
    // Backing (totalManaged) is 900_000_000 stroops; the vault path's
    // own off-chain liability is 11_000 minor = 1_100_000_000 stroops.
    // Breach = 1.1e9 − 9e8 = 2e8 ≥ the 1e8 threshold.
    mocks.readVaultState.mockResolvedValue({
      totalSupply: 1_000_000_000n,
      totalManaged: 900_000_000n,
      sharePricePpm: 1_000_000n,
    });
    mocks.getShareBalance.mockResolvedValue(0n);
    mocks.sumOffChainNetUserShares.mockResolvedValue(1_000_000_000n);
    mocks.sumVaultMirrorLiabilityMinor.mockResolvedValue(11_000n);
    mocks.getHotFloatRow.mockResolvedValue({ balanceMinor: 0n });

    const r = await runVaultDriftTick(ARGS);
    const sample = r.samples[0];
    expect(sample?.solvencyOver).toBe(true);
    expect(sample?.solvencyBreachStroops).toBe(200_000_000n);
    expect(sample?.mirrorLiabilityStroops).toBe(1_100_000_000n);
    expect(mocks.applyBinaryWatchdogAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        watchdogName: 'vault-drift-solvency:LOOPUSD:testnet',
        shouldBeActive: true,
      }),
    );
  });

  it('does NOT fire solvency from a large user-share position alone — the P0 non-tautology guard', async () => {
    // A huge user-share position valued at a high share price would
    // trip the OLD (tautological) `userShares × sharePrice vs managed`
    // check. With the mirror-liability formulation and a zero mirror
    // liability, there is no solvency breach — the on-chain share value
    // is irrelevant to solvency. This is the regression guard for
    // money-review V5 P0.
    mocks.listActiveVaults.mockResolvedValue([VAULT]);
    mocks.readVaultState.mockResolvedValue({
      totalSupply: 10_000_000_000n,
      totalManaged: 5_000_000_000n, // price 0.5 — a "loss" vs par
      sharePricePpm: 500_000n,
    });
    mocks.getShareBalance.mockResolvedValue(0n); // all 10e9 shares "with users"
    mocks.sumOffChainNetUserShares.mockResolvedValue(10_000_000_000n);
    mocks.sumVaultMirrorLiabilityMinor.mockResolvedValue(0n); // nothing actually owed
    mocks.getHotFloatRow.mockResolvedValue({ balanceMinor: 0n });

    const r = await runVaultDriftTick(ARGS);
    const sample = r.samples[0];
    expect(sample?.solvencyOver).toBe(false);
    expect(sample?.solvencyBreachStroops).toBeLessThanOrEqual(0n);
    expect(mocks.notifyVaultSolvencyBreach).not.toHaveBeenCalled();
  });

  it('hot float counts toward backing and can close an otherwise-open solvency breach', async () => {
    mocks.listActiveVaults.mockResolvedValue([VAULT]);
    mocks.readVaultState.mockResolvedValue({
      totalSupply: 1_000_000_000n,
      totalManaged: 900_000_000n,
      sharePricePpm: 1_000_000n,
    });
    mocks.getShareBalance.mockResolvedValue(0n);
    mocks.sumOffChainNetUserShares.mockResolvedValue(1_000_000_000n);
    mocks.sumVaultMirrorLiabilityMinor.mockResolvedValue(11_000n); // 1.1e9 stroops liability
    // 2_000_000 minor × 100_000 stroops/minor = 2e8 float; 9e8 + 2e8 = 1.1e9 = liability, exactly closes the gap.
    mocks.getHotFloatRow.mockResolvedValue({ balanceMinor: 2_000_000n });

    const r = await runVaultDriftTick(ARGS);
    expect(r.samples[0]?.solvencyOver).toBe(false);
  });

  it('skips a vault whose Soroban read fails, without flipping any alert state', async () => {
    mocks.listActiveVaults.mockResolvedValue([VAULT]);
    mocks.readVaultState.mockRejectedValue(new Error('RPC timeout'));

    const r = await runVaultDriftTick(ARGS);
    expect(r.checked).toBe(0);
    expect(r.skipped).toBe(1);
    expect(mocks.applyBinaryWatchdogAlert).not.toHaveBeenCalled();
  });

  it('is single-flighted fleet-wide: returns skippedLocked when another machine holds the lock', async () => {
    advisoryState.acquired = false;
    mocks.listActiveVaults.mockResolvedValue([VAULT]);
    const r = await runVaultDriftTick(ARGS);
    expect(r.skippedLocked).toBe(true);
    expect(mocks.listActiveVaults).not.toHaveBeenCalled();
  });

  it('re-arms: a recovered vault fires the recovered notifier via applyBinaryWatchdogAlert(shouldBeActive=false)', async () => {
    mocks.listActiveVaults.mockResolvedValue([VAULT]);
    mocks.readVaultState.mockResolvedValue({
      totalSupply: 1_000_000_000n,
      totalManaged: 1_000_000_000n,
      sharePricePpm: 1_000_000n,
    });
    mocks.getShareBalance.mockResolvedValue(0n);
    mocks.sumOffChainNetUserShares.mockResolvedValue(1_000_000_000n); // consistent — not over

    await runVaultDriftTick(ARGS);

    expect(mocks.applyBinaryWatchdogAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        watchdogName: 'vault-drift-shares:LOOPUSD:testnet',
        shouldBeActive: false,
      }),
    );
  });
});
