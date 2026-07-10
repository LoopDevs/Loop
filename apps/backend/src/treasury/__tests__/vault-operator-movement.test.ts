import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';

/**
 * `recordVaultOperatorMovement` (ADR 031 §D4, V5 gap (a)) — the
 * write primitive that makes R3-1
 * (`payments/operator-float-reconciliation.ts`) vault-aware. Proves:
 * records for a USDC-backed vault matching the configured issuer;
 * skips (no insert, no throw) for a non-USDC-underlying vault, an
 * issuer mismatch, an unconfigured deposit address, or a zero amount;
 * and never throws when the DB insert itself fails.
 */

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { mutableEnv, dbState, dbMock } = vi.hoisted(() => {
  const state = {
    inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
    tableNameOf: (_t: unknown): string => '',
    shouldThrowOnInsert: false,
  };
  const insert = (table: unknown): unknown => ({
    values: async (v: Record<string, unknown>) => {
      if (state.shouldThrowOnInsert) throw new Error('insert failed');
      state.inserts.push({ table: state.tableNameOf(table), values: v });
    },
  });
  return {
    mutableEnv: {
      LOOP_STELLAR_DEPOSIT_ADDRESS: 'GDEPOSITAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      LOOP_STELLAR_USDC_ISSUER: 'GUSDCISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    } as {
      LOOP_STELLAR_DEPOSIT_ADDRESS: string | undefined;
      LOOP_STELLAR_USDC_ISSUER: string | undefined;
    },
    dbState: state,
    dbMock: { insert },
  };
});

vi.mock('../../env.js', () => ({ env: mutableEnv }));
vi.mock('../../db/client.js', () => ({ db: dbMock }));

import { operatorManualMovements } from '../../db/schema.js';
import { recordVaultOperatorMovement } from '../vault-operator-movement.js';
import type { LoopVaultRow } from '../../credits/vaults/registry.js';

dbState.tableNameOf = (t: unknown) => getTableName(t as Parameters<typeof getTableName>[0]);

const USDC_VAULT: LoopVaultRow = {
  id: 'vault-1',
  assetCode: 'LOOPUSD',
  vaultContractId: 'CVAULT',
  shareAssetCode: 'LOOPUSD',
  shareAssetIssuer: 'CSHARE',
  underlyingAssetCode: 'USDC',
  underlyingAssetIssuer: 'GUSDCISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  strategyId: 'blend-usdc-pool',
  network: 'testnet',
  feeBps: 5000,
  active: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

const EUR_VAULT: LoopVaultRow = {
  ...USDC_VAULT,
  assetCode: 'LOOPEUR',
  underlyingAssetCode: 'EURC',
  underlyingAssetIssuer: 'GEURCISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};

beforeEach(() => {
  dbState.inserts = [];
  dbState.shouldThrowOnInsert = false;
  mutableEnv.LOOP_STELLAR_DEPOSIT_ADDRESS =
    'GDEPOSITAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  mutableEnv.LOOP_STELLAR_USDC_ISSUER = 'GUSDCISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
});

describe('recordVaultOperatorMovement', () => {
  it('records an unlinked manual movement for a USDC-backed vault matching the configured issuer', async () => {
    await recordVaultOperatorMovement({
      vault: USDC_VAULT,
      direction: 'out',
      amountStroops: 50_000_000n,
      reason: 'test deposit',
    });

    expect(dbState.inserts).toHaveLength(1);
    const row = dbState.inserts[0]?.values;
    expect(dbState.inserts[0]?.table).toBe(getTableName(operatorManualMovements));
    expect(row).toMatchObject({
      asset: 'usdc',
      account: mutableEnv.LOOP_STELLAR_DEPOSIT_ADDRESS,
      direction: 'out',
      amountStroops: 50_000_000n,
      movementPaymentId: null,
    });
    expect(row?.['createdBy']).toBe('system:vault-loopusd');
  });

  it('skips a non-USDC-underlying vault without throwing', async () => {
    await recordVaultOperatorMovement({
      vault: EUR_VAULT,
      direction: 'in',
      amountStroops: 10_000_000n,
      reason: 'test withdraw',
    });
    expect(dbState.inserts).toHaveLength(0);
  });

  it('skips when the deposit address is unconfigured', async () => {
    mutableEnv.LOOP_STELLAR_DEPOSIT_ADDRESS = undefined;
    await recordVaultOperatorMovement({
      vault: USDC_VAULT,
      direction: 'out',
      amountStroops: 10_000_000n,
      reason: 'test',
    });
    expect(dbState.inserts).toHaveLength(0);
  });

  it('skips when the vault underlying issuer does not match LOOP_STELLAR_USDC_ISSUER', async () => {
    const mismatched: LoopVaultRow = {
      ...USDC_VAULT,
      underlyingAssetIssuer: 'GDIFFERENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    };
    await recordVaultOperatorMovement({
      vault: mismatched,
      direction: 'out',
      amountStroops: 10_000_000n,
      reason: 'test',
    });
    expect(dbState.inserts).toHaveLength(0);
  });

  it('skips a non-positive amount', async () => {
    await recordVaultOperatorMovement({
      vault: USDC_VAULT,
      direction: 'out',
      amountStroops: 0n,
      reason: 'test',
    });
    expect(dbState.inserts).toHaveLength(0);
  });

  it('never throws when the DB insert fails', async () => {
    dbState.shouldThrowOnInsert = true;
    await expect(
      recordVaultOperatorMovement({
        vault: USDC_VAULT,
        direction: 'out',
        amountStroops: 10_000_000n,
        reason: 'test',
      }),
    ).resolves.toBeUndefined();
  });
});
