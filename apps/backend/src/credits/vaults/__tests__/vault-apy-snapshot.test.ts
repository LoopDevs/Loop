import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `vault-apy-snapshot.ts` (ADR 031 §D8, V5b) — the scheduled cron that
 * records each active vault's live share price into
 * `vault_share_price_snapshots`. Mocks the V2 Soroban client
 * (`readVaultState`), the V1 registry (`listActiveVaults` /
 * `getLatestSharePrice` / `recordSharePriceSnapshot` /
 * `vaultsEnabled`), and the advisory-lock helper. No network, no real
 * DB.
 */

vi.mock('../../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { mutableEnv, mocks, advisoryState } = vi.hoisted(() => {
  return {
    mutableEnv: {
      LOOP_STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
      LOOP_VAULT_APY_SNAPSHOT_INTERVAL_HOURS: 24,
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
      getLatestSharePrice: vi.fn<(a: string, n: string) => Promise<{ takenAt: Date } | null>>(
        async () => null,
      ),
      recordSharePriceSnapshot: vi.fn<(args: unknown) => Promise<void>>(async () => undefined),
    },
  };
});

vi.mock('../../../env.js', () => ({ env: mutableEnv }));
vi.mock('../registry.js', () => ({
  vaultsEnabled: mocks.vaultsEnabled,
  listActiveVaults: mocks.listActiveVaults,
  getLatestSharePrice: mocks.getLatestSharePrice,
  recordSharePriceSnapshot: mocks.recordSharePriceSnapshot,
}));
vi.mock('../vault-client.js', () => ({ readVaultState: mocks.readVaultState }));
vi.mock('../../../db/client.js', () => ({
  withAdvisoryLock: async <T>(
    _key: bigint,
    fn: () => Promise<T>,
  ): Promise<{ ran: true; value: T } | { ran: false }> =>
    advisoryState.acquired ? { ran: true, value: await fn() } : { ran: false },
}));

import { runVaultApySnapshotTick } from '../vault-apy-snapshot.js';

const VAULT_USD = {
  id: 'vault-1',
  assetCode: 'LOOPUSD',
  network: 'testnet',
  vaultContractId: 'CVAULT_USD',
  shareAssetCode: 'LOOPUSD',
  shareAssetIssuer: 'CSHARE_USD',
  underlyingAssetCode: 'USDC',
  underlyingAssetIssuer: 'GUSDC',
  strategyId: 'blend-usdc-pool',
  feeBps: 5000,
  active: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

const VAULT_EUR = { ...VAULT_USD, id: 'vault-2', assetCode: 'LOOPEUR', shareAssetCode: 'LOOPEUR' };

const NOW = new Date('2026-07-11T12:00:00Z');

beforeEach(() => {
  advisoryState.acquired = true;
  mocks.vaultsEnabled.mockReturnValue(true);
  mocks.listActiveVaults.mockReset();
  mocks.listActiveVaults.mockResolvedValue([]);
  mocks.readVaultState.mockReset();
  mocks.readVaultState.mockResolvedValue({
    totalSupply: 1_000_000_0000000n,
    totalManaged: 1_050_000_0000000n,
    sharePricePpm: 1_050_000n,
  });
  mocks.getLatestSharePrice.mockReset();
  mocks.getLatestSharePrice.mockResolvedValue(null);
  mocks.recordSharePriceSnapshot.mockReset();
  mocks.recordSharePriceSnapshot.mockResolvedValue(undefined);
});

describe('runVaultApySnapshotTick', () => {
  it('is a no-op when the vault subsystem is disabled', async () => {
    mocks.vaultsEnabled.mockReturnValue(false);
    mocks.listActiveVaults.mockResolvedValue([VAULT_USD]);
    const result = await runVaultApySnapshotTick({ now: NOW });
    expect(result).toEqual({
      checked: 0,
      deduped: 0,
      recorded: 0,
      errored: 0,
      samples: [],
      skippedLocked: false,
    });
    expect(mocks.readVaultState).not.toHaveBeenCalled();
    expect(mocks.recordSharePriceSnapshot).not.toHaveBeenCalled();
  });

  it('skips entirely when another machine holds the fleet-wide lock', async () => {
    advisoryState.acquired = false;
    mocks.listActiveVaults.mockResolvedValue([VAULT_USD]);
    const result = await runVaultApySnapshotTick({ now: NOW });
    expect(result.skippedLocked).toBe(true);
    expect(mocks.readVaultState).not.toHaveBeenCalled();
  });

  it('records a snapshot per active vault when no snapshot exists yet today', async () => {
    mocks.listActiveVaults.mockResolvedValue([VAULT_USD, VAULT_EUR]);
    mocks.getLatestSharePrice.mockResolvedValue(null);

    const result = await runVaultApySnapshotTick({ now: NOW });

    expect(result.checked).toBe(2);
    expect(result.recorded).toBe(2);
    expect(result.deduped).toBe(0);
    expect(result.errored).toBe(0);
    expect(mocks.recordSharePriceSnapshot).toHaveBeenCalledTimes(2);
    expect(mocks.recordSharePriceSnapshot).toHaveBeenCalledWith({
      assetCode: 'LOOPUSD',
      network: 'testnet',
      sharePricePpm: 1_050_000n,
      takenAt: NOW,
    });
    expect(mocks.recordSharePriceSnapshot).toHaveBeenCalledWith({
      assetCode: 'LOOPEUR',
      network: 'testnet',
      sharePricePpm: 1_050_000n,
      takenAt: NOW,
    });
  });

  it('dedups (no insert) when a snapshot already exists for the same UTC day', async () => {
    mocks.listActiveVaults.mockResolvedValue([VAULT_USD]);
    mocks.getLatestSharePrice.mockResolvedValue({ takenAt: new Date('2026-07-11T00:05:00Z') });

    const result = await runVaultApySnapshotTick({ now: NOW });

    expect(result.checked).toBe(1);
    expect(result.recorded).toBe(0);
    expect(result.deduped).toBe(1);
    expect(mocks.recordSharePriceSnapshot).not.toHaveBeenCalled();
  });

  it('records a fresh snapshot when the latest one is from a prior UTC day', async () => {
    mocks.listActiveVaults.mockResolvedValue([VAULT_USD]);
    mocks.getLatestSharePrice.mockResolvedValue({ takenAt: new Date('2026-07-10T23:59:00Z') });

    const result = await runVaultApySnapshotTick({ now: NOW });

    expect(result.recorded).toBe(1);
    expect(result.deduped).toBe(0);
    expect(mocks.recordSharePriceSnapshot).toHaveBeenCalledTimes(1);
  });

  it('counts a Soroban read failure as errored and continues to the next vault', async () => {
    mocks.listActiveVaults.mockResolvedValue([VAULT_USD, VAULT_EUR]);
    mocks.readVaultState.mockRejectedValueOnce(new Error('rpc down')).mockResolvedValueOnce({
      totalSupply: 1n,
      totalManaged: 1n,
      sharePricePpm: 1_000_000n,
    });

    const result = await runVaultApySnapshotTick({ now: NOW });

    expect(result.checked).toBe(2);
    expect(result.errored).toBe(1);
    expect(result.recorded).toBe(1);
    expect(mocks.recordSharePriceSnapshot).toHaveBeenCalledTimes(1);
  });
});
