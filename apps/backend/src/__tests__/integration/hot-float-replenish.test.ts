/**
 * Real-postgres integration test for `treasury/hot-float.ts`'s
 * `runHotFloatReplenishTick` under the documented two-driver race
 * (ADR 031 §Liquidity safeguard V4; module header "Concurrency" note;
 * `treasury/hot-float-reconciliation.ts` §(b)).
 *
 * WHY only a real DB proves this (the unit suite,
 * `treasury/__tests__/hot-float.test.ts`, mocks `db/client.js` with a
 * plain Map that has NO constraints): the failure is a genuine
 * postgres CHECK — `vault_hot_float_pending_shares_non_negative`
 * (migration 0062 / `db/schema/vaults.ts`) — firing as a 23514 that
 * ABORTS the replenish commit. Two replenish ticks can each capture
 * the SAME `pending_unredeemed_shares` from the UNLOCKED
 * `getHotFloatRow` read, then each land a REAL on-chain withdraw
 * (a network round-trip no row lock is held across) whose proceeds are
 * real USDC that must be credited. When the second tick's commit does
 * a blind `pending - shares` it underflows below zero, trips the
 * CHECK, and the whole transaction aborts — so that tick's proceeds
 * credit is lost AND its R3-1 `recordVaultOperatorMovement` (which
 * runs AFTER the commit) is never reached. That directly contradicts
 * the "each real inflow is credited + BOTH movements are recorded"
 * intent the module documents.
 *
 * The fix clamps the decrement (`GREATEST(pending - shares, 0)`) so
 * pending never goes negative while every landed withdraw is still
 * credited and recorded; the residual SHARE-level drift is what the
 * R3-1 reconciler exists to surface.
 *
 * Only the Soroban wire layer (`credits/vaults/vault-client.js`) and
 * the R3-1 write primitive (`treasury/vault-operator-movement.js`,
 * spied so we can assert it is REACHED — its own DB write is gated on
 * env not pinned in this lane) are mocked. `db`, `vault_hot_float`,
 * and its CHECK constraint are REAL postgres. Gated on LOOP_E2E_DB=1.
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

// R3-1 movement write — spied (not exercised against the DB): whether
// it is CALLED is the observable that separates "the commit aborted
// before the record step" (bug) from "the commit landed and the record
// step ran" (fixed). Its real insert is gated on LOOP_STELLAR_USDC_ISSUER
// (unset in this lane), so a real call would no-op anyway.
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

// pending shares seeded, and the minor proceeds each landed withdraw
// returns (1:1 share price, so minAmountsOut stays positive).
const PENDING_SHARES = 1_000_000n;
const PROCEEDS_MINOR = 1_050_000n;
const START_BALANCE = 100n;

async function seedFloat(pendingShares: bigint, balanceMinor: bigint): Promise<void> {
  await db.insert(vaultHotFloat).values({
    assetCode: ASSET,
    network: NETWORK,
    balanceMinor,
    pendingUnredeemedShares: pendingShares,
  });
}

async function readFloat(): Promise<{ balanceMinor: bigint; pendingUnredeemedShares: bigint }> {
  const [row] = await db
    .select()
    .from(vaultHotFloat)
    .where(and(eq(vaultHotFloat.assetCode, ASSET), eq(vaultHotFloat.network, NETWORK)));
  if (row === undefined) throw new Error('vault_hot_float row missing');
  return { balanceMinor: row.balanceMinor, pendingUnredeemedShares: row.pendingUnredeemedShares };
}

describe.runIf(RUN_INTEGRATION)(
  'runHotFloatReplenishTick — pending-shares CHECK abort (MNY-04-hotfloat)',
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

    it('second tick that races the same pending shares still credits the float + records its movement, and pending never goes negative (two concurrent ticks)', async () => {
      await seedFloat(PENDING_SHARES, START_BALANCE);

      // Barrier: neither withdraw returns until BOTH ticks have entered
      // it — which means BOTH have already run the UNLOCKED
      // `getHotFloatRow` read and captured pending = PENDING_SHARES.
      // Their commits then race the SAME shares (the documented
      // two-driver interleaving), so the loser's blind `pending - shares`
      // would underflow. Deterministic: no reliance on scheduler timing.
      let entered = 0;
      let release!: () => void;
      const barrier = new Promise<void>((res) => {
        release = res;
      });
      vaultClientMocks.withdrawFromVault.mockImplementation(async () => {
        entered += 1;
        if (entered >= 2) release();
        await barrier;
        return {
          txHash: `replenish-tx-${entered}`,
          amountsOut: [PROCEEDS_MINOR * STROOPS_PER_MINOR],
          deduped: false,
        };
      });

      const results = await Promise.allSettled([
        runHotFloatReplenishTick(VAULT),
        runHotFloatReplenishTick(VAULT),
      ]);

      // Neither tick aborts on the CHECK. (Current code: the second
      // committer underflows pending to -PENDING_SHARES, trips
      // `vault_hot_float_pending_shares_non_negative`, and that promise
      // rejects.)
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected).toEqual([]);

      // Both real inflows credited; pending retired to exactly zero and
      // NEVER negative (the CHECK held throughout).
      const float = await readFloat();
      expect(float.balanceMinor).toBe(START_BALANCE + PROCEEDS_MINOR * 2n);
      expect(float.pendingUnredeemedShares).toBe(0n);
      expect(float.pendingUnredeemedShares >= 0n).toBe(true);

      // Both ticks reached their post-commit R3-1 movement record — the
      // second's is NOT dropped by an aborted transaction.
      expect(movementMock).toHaveBeenCalledTimes(2);
    });

    it('a tick whose captured shares are retired by a concurrent commit WHILE its withdraw is in flight still credits its proceeds + records its movement (deterministic mid-flight decrement)', async () => {
      await seedFloat(PENDING_SHARES, START_BALANCE);

      // Simulate a concurrent replenish tick that already redeemed these
      // exact shares and committed (pending -> 0) while THIS tick's
      // on-chain withdraw is in flight — the same shape as the unit
      // suite's mid-flight-mutation test, inverted (decrement, not add),
      // and run against the REAL CHECK. A blind `pending - shares` then
      // underflows 0 -> -PENDING_SHARES and aborts.
      vaultClientMocks.withdrawFromVault.mockImplementation(async () => {
        await db
          .update(vaultHotFloat)
          .set({ pendingUnredeemedShares: 0n })
          .where(and(eq(vaultHotFloat.assetCode, ASSET), eq(vaultHotFloat.network, NETWORK)));
        return {
          txHash: 'replenish-tx-solo',
          amountsOut: [PROCEEDS_MINOR * STROOPS_PER_MINOR],
          deduped: false,
        };
      });

      const result = await runHotFloatReplenishTick(VAULT);

      // Tick completes (does NOT throw on the CHECK) and reports the credit.
      expect(result.replenished).toBe(true);
      expect(result.amountMinor).toBe(PROCEEDS_MINOR);

      const float = await readFloat();
      expect(float.balanceMinor).toBe(START_BALANCE + PROCEEDS_MINOR); // proceeds credited
      expect(float.pendingUnredeemedShares).toBe(0n); // clamped, never negative
      expect(float.pendingUnredeemedShares >= 0n).toBe(true);

      // The post-commit R3-1 movement record was reached (under the bug
      // the aborted transaction never gets here).
      expect(movementMock).toHaveBeenCalledTimes(1);
    });

    it('the ordinary single-tick path still fully retires pending and credits proceeds (no clamp side-effect)', async () => {
      await seedFloat(PENDING_SHARES, START_BALANCE);
      vaultClientMocks.withdrawFromVault.mockResolvedValue({
        txHash: 'replenish-tx-plain',
        amountsOut: [PROCEEDS_MINOR * STROOPS_PER_MINOR],
        deduped: false,
      });

      const result = await runHotFloatReplenishTick(VAULT);

      expect(result.replenished).toBe(true);
      const float = await readFloat();
      expect(float.balanceMinor).toBe(START_BALANCE + PROCEEDS_MINOR);
      expect(float.pendingUnredeemedShares).toBe(0n);
      expect(movementMock).toHaveBeenCalledTimes(1);
    });
  },
);
