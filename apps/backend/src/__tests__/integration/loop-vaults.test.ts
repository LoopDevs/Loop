/**
 * Real-postgres integration tests for the LOOPUSD/LOOPEUR vault
 * foundation (ADR 031 §Detailed design D3/D9, V1 / migration 0060).
 *
 * The unit suite (`credits/vaults/__tests__/registry.test.ts`) mocks
 * the DB entirely, so it can pin the flag-gating logic but cannot
 * exercise the DB CHECK/UNIQUE constraints — those only fire against
 * a real postgres. Mirrors `asset-drift-state-repo.test.ts`'s
 * `expectConstraintViolation` pattern.
 *
 * Runs under `vitest.integration.config.ts` (LOOP_E2E_DB=1 + a real
 * `loop_test` postgres) — the same lane as the flywheel walk.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { loopVaults, vaultSharePriceSnapshots } from '../../db/schema.js';
import { env } from '../../env.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';
import {
  vaultsEnabled,
  getActiveVault,
  listActiveVaults,
  recordSharePriceSnapshot,
  getLatestSharePrice,
} from '../../credits/vaults/registry.js';

const VALID_VAULT = {
  assetCode: 'LOOPUSD',
  vaultContractId: 'CVAULTCONTRACTID',
  shareAssetCode: 'LOOPUSD',
  shareAssetIssuer: 'CSHAREASSETISSUER',
  underlyingAssetCode: 'USDC',
  underlyingAssetIssuer: 'GAUNDERLYINGISSUER',
  strategyId: 'blend-usdc-pool',
  network: 'testnet',
  feeBps: 5000,
  active: true,
};

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAllTables();
});

describe('loop_vaults CHECK constraints', () => {
  /**
   * Drizzle wraps the postgres error ("Failed query: …") and parks
   * the constraint violation in `cause` — assert against the whole
   * chain rather than the wrapper message.
   */
  async function expectConstraintViolation(
    run: Promise<unknown>,
    constraint: string,
  ): Promise<void> {
    let thrown: unknown = null;
    await run.catch((err: unknown) => {
      thrown = err;
    });
    expect(thrown).not.toBeNull();
    const chain: string[] = [];
    let cursor: unknown = thrown;
    while (cursor instanceof Error) {
      chain.push(cursor.message);
      cursor = cursor.cause;
    }
    expect(chain.join(' | ')).toMatch(constraint);
  }

  it('rejects an unrecognised asset_code at the DB layer', async () => {
    await expectConstraintViolation(
      db.execute(
        sql`INSERT INTO loop_vaults
          (asset_code, vault_contract_id, share_asset_code, share_asset_issuer,
           underlying_asset_code, underlying_asset_issuer, strategy_id, network, fee_bps)
          VALUES ('NOTLOOPCURRENCY', 'C1', 'LOOPUSD', 'C2', 'USDC', 'G1', 'blend', 'testnet', 5000)`,
      ),
      'loop_vaults_asset_code_known',
    );
  });

  it('rejects an unrecognised network at the DB layer', async () => {
    await expectConstraintViolation(
      db.execute(
        sql`INSERT INTO loop_vaults
          (asset_code, vault_contract_id, share_asset_code, share_asset_issuer,
           underlying_asset_code, underlying_asset_issuer, strategy_id, network, fee_bps)
          VALUES ('LOOPUSD', 'C1', 'LOOPUSD', 'C2', 'USDC', 'G1', 'blend', 'devnet', 5000)`,
      ),
      'loop_vaults_network_known',
    );
  });
});

describe('loop_vaults_asset_network_unique constraint', () => {
  it('rejects a second row for the same (asset_code, network) pair', async () => {
    await db.insert(loopVaults).values(VALID_VAULT);
    let thrown: unknown = null;
    await db
      .insert(loopVaults)
      .values({ ...VALID_VAULT, vaultContractId: 'CDIFFERENTCONTRACT' })
      .catch((err: unknown) => {
        thrown = err;
      });
    expect(thrown).not.toBeNull();
    const chain: string[] = [];
    let cursor: unknown = thrown;
    while (cursor instanceof Error) {
      chain.push(cursor.message);
      cursor = cursor.cause;
    }
    expect(chain.join(' | ')).toMatch('loop_vaults_asset_network_unique');
  });

  it('allows the same asset_code on a different network', async () => {
    await db.insert(loopVaults).values(VALID_VAULT);
    await expect(
      db.insert(loopVaults).values({ ...VALID_VAULT, network: 'mainnet' }),
    ).resolves.not.toThrow();
  });
});

describe('registry read layer against a real loop_vaults row', () => {
  const previous = { vaultsEnabled: env.LOOP_VAULTS_ENABLED };

  afterEach(() => {
    env.LOOP_VAULTS_ENABLED = previous.vaultsEnabled;
  });

  it('vaultsEnabled() reflects LOOP_VAULTS_ENABLED', () => {
    env.LOOP_VAULTS_ENABLED = false;
    expect(vaultsEnabled()).toBe(false);
    env.LOOP_VAULTS_ENABLED = true;
    expect(vaultsEnabled()).toBe(true);
  });

  it('getActiveVault returns null when the flag is off, even though a matching row exists', async () => {
    env.LOOP_VAULTS_ENABLED = false;
    await db.insert(loopVaults).values(VALID_VAULT);
    const result = await getActiveVault('LOOPUSD', 'testnet');
    expect(result).toBeNull();
  });

  it('getActiveVault returns the row when the flag is on and it exists', async () => {
    env.LOOP_VAULTS_ENABLED = true;
    await db.insert(loopVaults).values(VALID_VAULT);
    const result = await getActiveVault('LOOPUSD', 'testnet');
    expect(result?.assetCode).toBe('LOOPUSD');
    expect(result?.network).toBe('testnet');
    expect(result?.vaultContractId).toBe('CVAULTCONTRACTID');
  });

  it('getActiveVault does not return an inactive row', async () => {
    env.LOOP_VAULTS_ENABLED = true;
    await db.insert(loopVaults).values({ ...VALID_VAULT, active: false });
    const result = await getActiveVault('LOOPUSD', 'testnet');
    expect(result).toBeNull();
  });

  it('listActiveVaults returns only active vaults on the requested network', async () => {
    env.LOOP_VAULTS_ENABLED = true;
    await db.insert(loopVaults).values(VALID_VAULT);
    await db.insert(loopVaults).values({ ...VALID_VAULT, assetCode: 'LOOPEUR', active: false });
    await db.insert(loopVaults).values({ ...VALID_VAULT, network: 'mainnet' });

    const result = await listActiveVaults('testnet');
    expect(result).toHaveLength(1);
    expect(result[0]?.assetCode).toBe('LOOPUSD');
  });
});

describe('recordSharePriceSnapshot / getLatestSharePrice round-trip', () => {
  const previous = { vaultsEnabled: env.LOOP_VAULTS_ENABLED };

  afterEach(() => {
    env.LOOP_VAULTS_ENABLED = previous.vaultsEnabled;
  });

  it('no-ops when the flag is off', async () => {
    env.LOOP_VAULTS_ENABLED = false;
    await recordSharePriceSnapshot({
      assetCode: 'LOOPUSD',
      network: 'testnet',
      sharePricePpm: 1_000_000n,
    });
    const rows = await db.select().from(vaultSharePriceSnapshots);
    expect(rows).toHaveLength(0);
  });

  it('records and reads back the latest sample, ordered by taken_at DESC', async () => {
    env.LOOP_VAULTS_ENABLED = true;
    await recordSharePriceSnapshot({
      assetCode: 'LOOPUSD',
      network: 'testnet',
      sharePricePpm: 1_000_000n,
      takenAt: new Date(Date.now() - 60_000),
    });
    await recordSharePriceSnapshot({
      assetCode: 'LOOPUSD',
      network: 'testnet',
      sharePricePpm: 1_050_000n,
      sourceLedger: 999_999n,
      takenAt: new Date(),
    });

    const latest = await getLatestSharePrice('LOOPUSD', 'testnet');
    expect(latest?.sharePricePpm).toBe(1_050_000n);
    expect(latest?.sourceLedger).toBe(999_999n);
  });

  it('scopes the latest sample per (asset_code, network)', async () => {
    env.LOOP_VAULTS_ENABLED = true;
    await recordSharePriceSnapshot({
      assetCode: 'LOOPUSD',
      network: 'testnet',
      sharePricePpm: 1_000_000n,
    });
    await recordSharePriceSnapshot({
      assetCode: 'LOOPEUR',
      network: 'testnet',
      sharePricePpm: 2_000_000n,
    });

    const usd = await getLatestSharePrice('LOOPUSD', 'testnet');
    const eur = await getLatestSharePrice('LOOPEUR', 'testnet');
    expect(usd?.sharePricePpm).toBe(1_000_000n);
    expect(eur?.sharePricePpm).toBe(2_000_000n);
  });

  it('getLatestSharePrice returns null when no sample has been recorded', async () => {
    env.LOOP_VAULTS_ENABLED = true;
    const result = await getLatestSharePrice('LOOPUSD', 'testnet');
    expect(result).toBeNull();
  });
});
