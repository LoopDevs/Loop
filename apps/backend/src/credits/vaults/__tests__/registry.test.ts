import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The mocked env object is mutated per-test — `vaultsEnabled()` reads
 * env at call time, so no module re-import dance is needed. Mirrors
 * `wallet/__tests__/provider.test.ts`'s pattern.
 */
vi.mock('../../../env.js', () => ({
  env: { LOOP_VAULTS_ENABLED: false },
}));

const { dbState, dbMock } = vi.hoisted(() => {
  const s: {
    selectRows: unknown[];
    insertCalls: Array<Record<string, unknown>>;
  } = { selectRows: [], insertCalls: [] };

  const selectChain: Record<string, unknown> = {};
  selectChain['select'] = vi.fn(() => selectChain);
  selectChain['from'] = vi.fn(() => selectChain);
  selectChain['where'] = vi.fn(() => selectChain);
  selectChain['orderBy'] = vi.fn(() => selectChain);
  selectChain['limit'] = vi.fn(async () => s.selectRows);
  // listActiveVaults doesn't call .limit() — awaiting the chain
  // directly must also resolve to the configured rows.
  (selectChain as unknown as PromiseLike<unknown[]>).then = (onFulfilled) =>
    Promise.resolve(s.selectRows).then(onFulfilled as never);

  const insertChain: Record<string, unknown> = {};
  insertChain['insert'] = vi.fn(() => insertChain);
  insertChain['values'] = vi.fn(async (v: Record<string, unknown>) => {
    s.insertCalls.push(v);
  });

  const m = { ...selectChain, ...insertChain };
  return { dbState: s, dbMock: m };
});
vi.mock('../../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../../db/schema.js', () => ({
  loopVaults: {
    assetCode: 'asset_code',
    network: 'network',
    active: 'active',
  },
  vaultSharePriceSnapshots: {
    assetCode: 'asset_code',
    network: 'network',
    takenAt: 'taken_at',
  },
}));

import { env } from '../../../env.js';
import {
  vaultsEnabled,
  getActiveVault,
  listActiveVaults,
  recordSharePriceSnapshot,
  getLatestSharePrice,
} from '../registry.js';

const mutableEnv = env as unknown as { LOOP_VAULTS_ENABLED: boolean };

const VAULT_ROW = {
  id: 'vault-1',
  assetCode: 'LOOPUSD',
  vaultContractId: 'CVAULT...',
  shareAssetCode: 'LOOPUSD',
  shareAssetIssuer: 'CSHARE...',
  underlyingAssetCode: 'USDC',
  underlyingAssetIssuer: 'GAUSDC...',
  strategyId: 'blend-usdc-pool',
  network: 'testnet',
  feeBps: 5000,
  active: true,
  createdAt: new Date(),
};

const SNAPSHOT_ROW = {
  id: 'snap-1',
  assetCode: 'LOOPUSD',
  network: 'testnet',
  takenAt: new Date(),
  sharePricePpm: 1_050_000n,
  sourceLedger: 12345n,
};

beforeEach(() => {
  mutableEnv.LOOP_VAULTS_ENABLED = false;
  dbState.selectRows = [];
  dbState.insertCalls = [];
});

describe('vaultsEnabled', () => {
  it('reflects LOOP_VAULTS_ENABLED (default false)', () => {
    expect(vaultsEnabled()).toBe(false);
    mutableEnv.LOOP_VAULTS_ENABLED = true;
    expect(vaultsEnabled()).toBe(true);
  });
});

describe('getActiveVault', () => {
  it('returns null when the flag is off, regardless of table contents', async () => {
    dbState.selectRows = [VAULT_ROW];
    const result = await getActiveVault('LOOPUSD', 'testnet');
    expect(result).toBeNull();
  });

  it('returns null when the flag is on but no row matches', async () => {
    mutableEnv.LOOP_VAULTS_ENABLED = true;
    dbState.selectRows = [];
    const result = await getActiveVault('LOOPUSD', 'testnet');
    expect(result).toBeNull();
  });

  it('returns the row when the flag is on and a row exists', async () => {
    mutableEnv.LOOP_VAULTS_ENABLED = true;
    dbState.selectRows = [VAULT_ROW];
    const result = await getActiveVault('LOOPUSD', 'testnet');
    expect(result).toEqual(VAULT_ROW);
  });
});

describe('listActiveVaults', () => {
  it('returns an empty array when the flag is off, regardless of table contents', async () => {
    dbState.selectRows = [VAULT_ROW];
    const result = await listActiveVaults('testnet');
    expect(result).toEqual([]);
  });

  it('returns the active vaults when the flag is on', async () => {
    mutableEnv.LOOP_VAULTS_ENABLED = true;
    dbState.selectRows = [VAULT_ROW];
    const result = await listActiveVaults('testnet');
    expect(result).toEqual([VAULT_ROW]);
  });
});

describe('recordSharePriceSnapshot / getLatestSharePrice round-trip', () => {
  it('recordSharePriceSnapshot no-ops when the flag is off (no insert)', async () => {
    await recordSharePriceSnapshot({
      assetCode: 'LOOPUSD',
      network: 'testnet',
      sharePricePpm: 1_000_000n,
    });
    expect(dbState.insertCalls).toEqual([]);
  });

  it('getLatestSharePrice returns null when the flag is off, regardless of table contents', async () => {
    dbState.selectRows = [SNAPSHOT_ROW];
    const result = await getLatestSharePrice('LOOPUSD', 'testnet');
    expect(result).toBeNull();
  });

  it('records a snapshot and reads it back when the flag is on', async () => {
    mutableEnv.LOOP_VAULTS_ENABLED = true;
    await recordSharePriceSnapshot({
      assetCode: 'LOOPUSD',
      network: 'testnet',
      sharePricePpm: 1_050_000n,
      sourceLedger: 12345n,
    });
    expect(dbState.insertCalls).toHaveLength(1);
    expect(dbState.insertCalls[0]).toMatchObject({
      assetCode: 'LOOPUSD',
      network: 'testnet',
      sharePricePpm: 1_050_000n,
      sourceLedger: 12345n,
    });

    dbState.selectRows = [SNAPSHOT_ROW];
    const result = await getLatestSharePrice('LOOPUSD', 'testnet');
    expect(result).toEqual(SNAPSHOT_ROW);
  });

  it('omits sourceLedger from the insert when not provided (column defaults to null)', async () => {
    mutableEnv.LOOP_VAULTS_ENABLED = true;
    await recordSharePriceSnapshot({
      assetCode: 'LOOPEUR',
      network: 'mainnet',
      sharePricePpm: 1_000_000n,
    });
    expect(dbState.insertCalls[0]).toMatchObject({
      assetCode: 'LOOPEUR',
      network: 'mainnet',
      sharePricePpm: 1_000_000n,
      sourceLedger: null,
    });
  });
});
