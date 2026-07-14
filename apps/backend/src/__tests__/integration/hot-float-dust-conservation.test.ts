/**
 * Real-postgres integration test for MNY-06-hotfloat: the hot-float
 * REPLENISH path (`treasury/hot-float.ts`'s `runHotFloatReplenishTick`)
 * must CONSERVE every sub-minor stroop of the vault-withdraw proceeds,
 * not truncate the remainder away on each tick.
 *
 * The defect: `amountOutMinor = amountOutStroops / STROOPS_PER_MINOR`
 * (truncating integer division) discarded `amountOutStroops %
 * STROOPS_PER_MINOR` stroops of REAL, already-landed on-chain USDC every
 * tick. A single drop is sub-cent, but the float replenishes
 * continuously and each dropped fraction is gone for good, so over many
 * ticks the discarded remainders ACCUMULATE into a growing, unaccounted
 * gap between the recorded float and the vault's actual proceeds — money
 * quietly leaked from the operator's working capital.
 *
 * The fix (migration 0069) adds `vault_hot_float.carry_stroops`: the
 * replenish tick holds the remainder there and flushes a whole minor
 * into `balance_minor` once carry crosses STROOPS_PER_MINOR. The
 * conservation invariant this test pins:
 *
 *     balance_minor * PER + carry_stroops == Σ amount_out_stroops
 *
 * WHY only a real DB proves this: the carry lives in a REAL postgres
 * column with a REAL `vault_hot_float_carry_bounded` CHECK (0 <= carry <
 * PER), and the credit is a pure-SQL read-modify-write over that column.
 * The mocked-Map unit harness (`treasury/__tests__/hot-float.test.ts`)
 * cannot exercise the column default, the CHECK, or the SQL modulo/floor
 * semantics. Only the Soroban wire layer
 * (`credits/vaults/vault-client.js`) and the R3-1 movement write
 * (`treasury/vault-operator-movement.js`) are mocked; `db`,
 * `vault_hot_float`, and its CHECK are REAL postgres. Gated on
 * LOOP_E2E_DB=1.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

// Soroban wire layer — test-controlled withdraw proceeds, no network.
const { vaultClientMocks } = vi.hoisted(() => ({
  vaultClientMocks: {
    readVaultState: vi.fn(),
    withdrawFromVault: vi.fn(),
  },
}));
vi.mock('../../credits/vaults/vault-client.js', () => ({
  readVaultState: (...args: unknown[]) => vaultClientMocks.readVaultState(...args),
  withdrawFromVault: (...args: unknown[]) => vaultClientMocks.withdrawFromVault(...args),
}));

// R3-1 movement write — spied out (its own insert is env-gated and not
// this test's subject; we only care about the float ledger arithmetic).
const { movementMock } = vi.hoisted(() => ({
  movementMock: vi.fn(async (..._args: unknown[]) => {}),
}));
vi.mock('../../treasury/vault-operator-movement.js', () => ({
  recordVaultOperatorMovement: (...args: unknown[]) => movementMock(...args),
}));

import { db } from '../../db/client.js';
import { vaultHotFloat } from '../../db/schema.js';
import { runHotFloatReplenishTick } from '../../treasury/hot-float.js';
import type { LoopVaultRow } from '../../credits/vaults/registry.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';

/** Mirrors `hot-float.ts`'s STROOPS_PER_MINOR (7-decimal convention). */
const STROOPS_PER_MINOR = 100_000n;

const ASSET = 'LOOPUSD' as const;
const NETWORK = 'testnet' as const;

const VAULT: LoopVaultRow = {
  id: 'vault-row-1',
  assetCode: 'LOOPUSD',
  vaultContractId: 'CVAULTCONTRACTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  shareAssetCode: 'LOOPUSD',
  shareAssetIssuer: 'CSHARECONTRACTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  underlyingAssetCode: 'USDC',
  underlyingAssetIssuer: 'GUSDCISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  strategyId: 'blend-usdc-pool',
  network: 'testnet',
  feeBps: 5000,
  active: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

// Positive pending shares so `minAmountsOut` (share-price 1:1, minus
// 0.5% slippage) stays > 0 and the tick proceeds. The proceeds each
// landed withdraw returns are set per-test on the mock and are
// DECOUPLED from `shares` (the mock returns a fixed stroop amount), so
// each test drives an exact, non-whole-minor proceeds value.
const PER_TICK_SHARES = 150_000n;

async function seedFloat(): Promise<void> {
  await db.insert(vaultHotFloat).values({
    assetCode: ASSET,
    network: NETWORK,
    balanceMinor: 0n,
    pendingUnredeemedShares: 0n,
    // carry_stroops omitted — exercises the migration-0069 DEFAULT 0.
  });
}

async function armPending(): Promise<void> {
  const [row] = await db
    .select()
    .from(vaultHotFloat)
    .where(and(eq(vaultHotFloat.assetCode, ASSET), eq(vaultHotFloat.network, NETWORK)));
  if (row === undefined) throw new Error('vault_hot_float row missing');
  await db
    .update(vaultHotFloat)
    .set({ pendingUnredeemedShares: row.pendingUnredeemedShares + PER_TICK_SHARES })
    .where(and(eq(vaultHotFloat.assetCode, ASSET), eq(vaultHotFloat.network, NETWORK)));
}

async function readFloat(): Promise<{ balanceMinor: bigint; carryStroops: bigint }> {
  const [row] = await db
    .select()
    .from(vaultHotFloat)
    .where(and(eq(vaultHotFloat.assetCode, ASSET), eq(vaultHotFloat.network, NETWORK)));
  if (row === undefined) throw new Error('vault_hot_float row missing');
  return { balanceMinor: row.balanceMinor, carryStroops: row.carryStroops };
}

/** Drives `count` replenish ticks, each returning `perTickStroops` proceeds. */
async function runTicks(count: bigint, perTickStroops: bigint): Promise<bigint> {
  vaultClientMocks.withdrawFromVault.mockImplementation(async () => ({
    txHash: 'replenish-tx',
    amountsOut: [perTickStroops],
    deduped: false,
  }));
  let totalStroopsMoved = 0n;
  for (let i = 0n; i < count; i++) {
    await armPending();
    const res = await runHotFloatReplenishTick(VAULT);
    expect(res.replenished).toBe(true);
    totalStroopsMoved += perTickStroops;
  }
  return totalStroopsMoved;
}

describe.runIf(RUN_INTEGRATION)(
  'runHotFloatReplenishTick — sub-minor stroop conservation (MNY-06-hotfloat)',
  () => {
    beforeAll(async () => {
      await ensureMigrated();
    });

    beforeEach(async () => {
      await truncateAllTables();
      vaultClientMocks.readVaultState.mockReset();
      vaultClientMocks.readVaultState.mockResolvedValue({
        totalSupply: 1_000_000_000n,
        totalManaged: 1_000_000_000n,
        sharePricePpm: 1_000_000n, // 1:1
      });
      vaultClientMocks.withdrawFromVault.mockReset();
      movementMock.mockClear();
    });

    it('carries the dropped remainder so the accumulated float == floor(Σ stroops / PER), not Σ floor(each) — remainder lands on a whole boundary', async () => {
      // 10 ticks × 150_000 stroops = 1.5 minor each. Per-tick truncation
      // credits floor(1.5) = 1 minor → 10 minor total, LEAKING 0.5 minor
      // every tick. The conserved value is floor(1_500_000 / 100_000) =
      // 15 minor; carry nets to zero because 10 × 50_000 = 5 whole minors.
      const TICKS = 10n;
      const perTickStroops = 150_000n;
      await seedFloat();

      const total = await runTicks(TICKS, perTickStroops);
      expect(total).toBe(1_500_000n);

      const { balanceMinor, carryStroops } = await readFloat();
      const conservedMinor = total / STROOPS_PER_MINOR; // floor of the ACCUMULATED total
      const leakedByTruncation = TICKS * (perTickStroops / STROOPS_PER_MINOR); // the un-fixed result

      // The systematic leak the truncating code produced (documented for
      // the record): 15 conserved − 10 credited = 5 minor lost.
      expect(conservedMinor).toBe(15n);
      expect(leakedByTruncation).toBe(10n);
      expect(conservedMinor - leakedByTruncation).toBe(5n);

      // The fix: float credited the accumulated-floor, zero dust lost.
      expect(balanceMinor).toBe(conservedMinor); // 15, not 10
      expect(carryStroops).toBe(0n);

      // Conservation invariant — no stroop unaccounted.
      expect(balanceMinor * STROOPS_PER_MINOR + carryStroops).toBe(total);
    });

    it('conserves when the accumulated total does NOT land on a whole boundary — leftover persists in carry_stroops (0 <= carry < PER)', async () => {
      // 10 ticks × 133_333 stroops = 1.33333 minor each. Per-tick
      // truncation credits floor = 1 → 10 minor, and the leftover never
      // reaches a whole minor within a single tick, so ALL of it leaks.
      // Conserved: 1_333_330 stroops = 13 minor + 33_330 carry.
      const TICKS = 10n;
      const perTickStroops = 133_333n;
      await seedFloat();

      const total = await runTicks(TICKS, perTickStroops);
      expect(total).toBe(1_333_330n);

      const { balanceMinor, carryStroops } = await readFloat();

      expect(balanceMinor).toBe(13n); // truncating code would have credited 10
      expect(carryStroops).toBe(33_330n); // truncating code leaves this 0
      expect(carryStroops).toBeGreaterThanOrEqual(0n);
      expect(carryStroops).toBeLessThan(STROOPS_PER_MINOR);

      // Conservation invariant — recorded balance plus carry equals every
      // stroop moved; nothing dropped.
      expect(balanceMinor * STROOPS_PER_MINOR + carryStroops).toBe(total);
    });
  },
);
