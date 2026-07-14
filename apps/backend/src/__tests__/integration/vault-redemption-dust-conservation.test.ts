/**
 * Real-postgres integration test for MNY-06-REDEMPTION-DUST: the vault
 * redemption SLOW path (`credits/vaults/vault-redemptions.ts`'s
 * `payoutStep`) must CONSERVE every sub-minor stroop of the on-chain
 * `withdrawFromVault` proceeds it credits back to the hot float, not
 * truncate the remainder away on each redemption.
 *
 * The defect (sibling of the committed MNY-06-hotfloat, on the SAME
 * `vault_hot_float` float): the slow path credited the float with
 *
 *     amountOutMinor = amountOutStroops / STROOPS_PER_MINOR   // TRUNCATES
 *     netFloatDelta  = amountOutMinor - row.valueMinor
 *
 * so `amountOutStroops % STROOPS_PER_MINOR` stroops of REAL,
 * already-landed favorable-slippage on-chain USDC were silently DROPPED
 * from the operator's working capital on every slow-path redemption.
 * A single drop is sub-cent, but redemptions recur and each dropped
 * remainder is gone for good, so the discarded fractions ACCUMULATE into
 * a growing, unaccounted gap between the recorded float and the vault's
 * actual proceeds — exactly the drift R3-1 float reconciliation would
 * eventually surface as unexplained.
 *
 * The fix threads the dropped remainder into `vault_hot_float.carry_stroops`
 * (migration 0069, reused — no new schema) via the now carry-aware
 * `applyHotFloatDeltaInTx`, flushing a whole minor into `balance_minor`
 * once carry crosses STROOPS_PER_MINOR — the SAME carry mechanism the
 * replenish path (MNY-06-hotfloat) uses. Conservation invariant this
 * test pins across N slow-path redemptions:
 *
 *     balance_minor * PER + carry_stroops == Σ amountOutStroops − Σ valueMinor*PER
 *
 * i.e. no stroop of proceeds credited to the float is ever dropped, and
 * the signed whole-minor slippage still lands (only) in `balance_minor`.
 *
 * WHY only a real DB proves this: the carry lives in a REAL postgres
 * column with a REAL `vault_hot_float_carry_bounded` CHECK (0 <= carry <
 * PER), and the credit is a pure-SQL read-modify-write over that column
 * threaded through the payout transaction alongside the row's own state
 * transition. Only the Soroban wire layer
 * (`credits/vaults/vault-client.js`) and Privy (`wallet/provider.js`)
 * are mocked; `db`, `vault_hot_float`, `vault_redemptions`, `orders`,
 * `user_credits`, `credit_transactions`, and every CHECK/trigger are
 * REAL postgres. Gated on LOOP_E2E_DB=1.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { Keypair, Address } from '@stellar/stellar-sdk';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

const SHARE_CONTRACT_ID = Address.contract(Buffer.alloc(32, 4)).toString();
const VAULT_CONTRACT_ID = Address.contract(Buffer.alloc(32, 3)).toString();

// Only the Soroban wire layer is mocked — the slow-path withdraw
// proceeds are test-controlled per redemption (no network).
const { vaultClientState, vaultClientMocks } = vi.hoisted(() => ({
  vaultClientState: {
    withdrawResult: null as null | { txHash: string; amountsOut: bigint[] },
  },
  vaultClientMocks: {
    transferShares: vi.fn(async (args: { onSigned: (h: string) => Promise<void> | void }) => {
      await args.onSigned('collect-tx');
      return { txHash: 'collect-tx', deduped: false };
    }),
    withdrawFromVault: vi.fn(async (args: { onSigned: (h: string) => Promise<void> | void }) => {
      const r = vaultClientState.withdrawResult ?? {
        txHash: 'default-withdraw-tx',
        amountsOut: [50_000_000n],
      };
      await args.onSigned(r.txHash);
      return { txHash: r.txHash, amountsOut: r.amountsOut, deduped: false };
    }),
    readVaultState: vi.fn(async () => ({
      totalSupply: 1_000_000_000n,
      totalManaged: 1_000_000_000n,
      sharePricePpm: 1_000_000n,
    })),
    resolveOperatorPublicKey: vi.fn(() => Keypair.random().publicKey()),
  },
}));
vi.mock('../../credits/vaults/vault-client.js', () => ({
  transferShares: (...args: Parameters<typeof vaultClientMocks.transferShares>) =>
    vaultClientMocks.transferShares(...args),
  withdrawFromVault: (...args: Parameters<typeof vaultClientMocks.withdrawFromVault>) =>
    vaultClientMocks.withdrawFromVault(...args),
  readVaultState: (...args: Parameters<typeof vaultClientMocks.readVaultState>) =>
    vaultClientMocks.readVaultState(...args),
  resolveOperatorPublicKey: () => vaultClientMocks.resolveOperatorPublicKey(),
}));

// No real Privy call — collectSharesStep only needs a non-null provider
// (the share transfer itself is fully mocked above).
vi.mock('../../wallet/provider.js', () => ({
  getWalletProvider: () => ({ name: 'privy' as const, createWallet: vi.fn(), rawSign: vi.fn() }),
}));

vi.mock('../../discord.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    notifyVaultRedemptionsStuck: vi.fn(async () => true),
  };
});

import { db } from '../../db/client.js';
import { users, orders, loopVaults, vaultRedemptions, vaultHotFloat } from '../../db/schema.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import {
  ensureMigrated,
  truncateAllTables,
  seedUserCreditsWithBackingLedger,
} from './db-test-setup.js';
import { computeLedgerDriftSql } from '../../credits/ledger-invariant.js';
import {
  claimVaultRedemption,
  driveOneVaultRedemption,
} from '../../credits/vaults/vault-redemptions.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

/** Mirrors `vault-redemptions.ts`'s STROOPS_PER_MINOR (7-decimal convention). */
const STROOPS_PER_MINOR = 100_000n;

async function seedUser(): Promise<{ id: string; walletAddress: string }> {
  const email = `vault-redemption-dust-${crypto.randomUUID()}@test.local`;
  const user = await findOrCreateUserByEmail(email);
  const walletAddress = Keypair.random().publicKey();
  await db
    .update(users)
    .set({
      homeCurrency: 'USD',
      walletProvider: 'privy',
      walletId: `wallet-${crypto.randomUUID()}`,
      walletAddress,
      walletProvisioning: 'activated',
    })
    .where(eq(users.id, user.id));
  return { id: user.id, walletAddress };
}

async function seedOrder(userId: string, chargeMinor: bigint): Promise<string> {
  const merchantId = crypto.randomUUID();
  const [order] = await db
    .insert(orders)
    .values({
      userId,
      merchantId,
      faceValueMinor: chargeMinor,
      currency: 'USD',
      chargeMinor,
      chargeCurrency: 'USD',
      paymentMethod: 'loop_asset',
      paymentMemo: `test-memo-${crypto.randomUUID()}`,
      wholesalePct: '70.00',
      userCashbackPct: '5.00',
      loopMarginPct: '25.00',
      wholesaleMinor: (chargeMinor * 70n) / 100n,
      userCashbackMinor: (chargeMinor * 5n) / 100n,
      loopMarginMinor: (chargeMinor * 25n) / 100n,
      state: 'pending_payment',
    })
    .returning({ id: orders.id });
  return order!.id;
}

async function seedVault(): Promise<void> {
  await db.insert(loopVaults).values({
    assetCode: 'LOOPUSD',
    vaultContractId: VAULT_CONTRACT_ID,
    shareAssetCode: 'LOOPUSD',
    shareAssetIssuer: SHARE_CONTRACT_ID,
    underlyingAssetCode: 'USDC',
    underlyingAssetIssuer: 'GUSDCISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    strategyId: 'blend-usdc-pool',
    network: 'testnet',
    feeBps: 5000,
    active: true,
  });
}

async function readFloat(): Promise<{ balanceMinor: bigint; carryStroops: bigint }> {
  const [row] = await db
    .select()
    .from(vaultHotFloat)
    .where(and(eq(vaultHotFloat.assetCode, 'LOOPUSD'), eq(vaultHotFloat.network, 'testnet')));
  if (row === undefined) return { balanceMinor: 0n, carryStroops: 0n };
  return { balanceMinor: row.balanceMinor, carryStroops: row.carryStroops };
}

/**
 * Drives ONE full slow-path redemption (float never covers it, so it
 * takes the synchronous `withdrawFromVault`) with `proceedsStroops` of
 * proceeds. Asserts it genuinely settled on the SLOW path — the fix's
 * whole point is the slow-path credit, so a redemption that slipped onto
 * the fast path would not exercise it. Returns the float AFTER it lands.
 */
async function runOneSlowRedemption(
  user: { id: string; walletAddress: string },
  valueMinor: bigint,
  proceedsStroops: bigint,
  seq: number,
): Promise<{ balanceMinor: bigint; carryStroops: bigint }> {
  const orderId = await seedOrder(user.id, valueMinor);
  vaultClientState.withdrawResult = {
    txHash: `withdraw-dust-${seq}`,
    amountsOut: [proceedsStroops],
  };

  const row = await claimVaultRedemption({
    sourceType: 'order_redeem',
    sourceId: orderId,
    userId: user.id,
    assetCode: 'LOOPUSD',
    network: 'testnet',
    valueMinor,
    fromAddress: user.walletAddress,
  });
  const outcome = await driveOneVaultRedemption(row);
  expect(outcome).toBe('settled');

  const [redemptionRow] = await db
    .select()
    .from(vaultRedemptions)
    .where(eq(vaultRedemptions.id, row.id));
  // Guard: the fix lives on the SLOW branch; assert we truly took it.
  expect(redemptionRow?.payoutPath).toBe('slow');

  return readFloat();
}

describeIf(
  'vault-redemption slow-path — sub-minor stroop conservation (MNY-06-REDEMPTION-DUST)',
  () => {
    beforeAll(async () => {
      await ensureMigrated();
    });

    beforeEach(async () => {
      await truncateAllTables();
      vaultClientState.withdrawResult = null;
      vaultClientMocks.transferShares.mockClear();
      vaultClientMocks.withdrawFromVault.mockClear();
      await seedVault();
    });

    // The vault redemption mirror step must never desync user_credits from
    // credit_transactions (mirrors the sibling redemption suite).
    afterEach(async () => {
      const drift = await computeLedgerDriftSql(db);
      expect(drift).toEqual([]);
    });

    it('carries the dropped proceeds remainder so the accumulated float conserves every stroop — carry nets back to a WHOLE boundary', async () => {
      // 2 slow redemptions, valueMinor=500 (obligation 50_000_000 stroops
      // each), proceeds 50_050_000 stroops each = 500.5 minor — FAVORABLE
      // slippage of 0.5 minor (50_000 stroops) per redemption. The
      // truncating code credited netFloatDelta = floor(500.5) − 500 = 0
      // each: the operator's float gained NOTHING despite two genuinely
      // favorable on-chain withdraws — 100_000 stroops (a full minor) of
      // real USDC quietly dropped. The fix carries each 50_000 remainder;
      // two of them cross a whole minor, so balance == 1, carry == 0.
      const user = await seedUser();
      await seedUserCreditsWithBackingLedger(db, {
        userId: user.id,
        currency: 'USD',
        balanceMinor: 100_000n,
        reason: 'dust-test fixture balance',
      });

      const VALUE = 500n;
      const PROCEEDS = 50_050_000n; // 500.5 minor
      const N = 2;

      // Running expected conserved stroops = Σ (proceeds − obligation).
      const perRedemptionConserved = PROCEEDS - VALUE * STROOPS_PER_MINOR; // 50_000
      // What the truncating (un-fixed) code credits per redemption, in
      // stroops — floor(proceeds/PER) − value, times PER, no carry.
      const truncatingCreditStroops = (PROCEEDS / STROOPS_PER_MINOR - VALUE) * STROOPS_PER_MINOR; // 0

      const observedDrift: bigint[] = [];
      for (let i = 0; i < N; i++) {
        const { balanceMinor, carryStroops } = await runOneSlowRedemption(user, VALUE, PROCEEDS, i);
        const expectedConserved = perRedemptionConserved * BigInt(i + 1);
        const actualFloatStroops = balanceMinor * STROOPS_PER_MINOR + carryStroops;
        // Drift the un-fixed truncating code WOULD have accrued by now —
        // reported to show it GROWS (50_000 → 100_000). With the fix the
        // observed drift below is 0 at every step.
        observedDrift.push(expectedConserved - actualFloatStroops);
        expect(actualFloatStroops).toBe(expectedConserved); // fix: zero drift, each step
      }

      // The leak the truncating code would have produced grows every
      // redemption and never self-heals.
      expect(truncatingCreditStroops).toBe(0n);
      expect(observedDrift).toEqual([0n, 0n]); // fixed code: no drift, ever

      const { balanceMinor, carryStroops } = await readFloat();
      const totalConserved = perRedemptionConserved * BigInt(N); // 100_000
      expect(balanceMinor).toBe(1n); // truncating code would leave 0
      expect(carryStroops).toBe(0n); // remainder crossed a whole boundary
      expect(balanceMinor * STROOPS_PER_MINOR + carryStroops).toBe(totalConserved);
    });

    it('conserves when the accumulated remainder does NOT land on a whole boundary — leftover persists in carry_stroops (0 <= carry < PER)', async () => {
      // 3 slow redemptions, valueMinor=500 each. Proceeds chosen with
      // distinct non-zero sub-minor remainders so the carry accumulates,
      // crosses a whole minor mid-run, and lands non-zero:
      //   R1 50_150_000 (501.5)  netΔ=+1  rem 50_000
      //   R2 50_133_333 (501.333) netΔ=+1  rem 33_333
      //   R3 50_090_000 (500.9)  netΔ= 0  rem 90_000
      // Conserved stroops = 150_000 + 133_333 + 90_000 = 373_333
      //   → balance 3, carry 73_333  (3*100_000 + 73_333 = 373_333).
      // Truncating code credits netΔ only (1 + 1 + 0 = 2 minor, carry 0)
      // → leaks 173_333 stroops, drift growing 50_000 → 83_333 → 173_333.
      const user = await seedUser();
      await seedUserCreditsWithBackingLedger(db, {
        userId: user.id,
        currency: 'USD',
        balanceMinor: 100_000n,
        reason: 'dust-test fixture balance',
      });

      const VALUE = 500n;
      const OBLIGATION = VALUE * STROOPS_PER_MINOR;
      const proceeds = [50_150_000n, 50_133_333n, 50_090_000n];

      let runningConserved = 0n;
      let runningTruncating = 0n; // what the un-fixed code would credit, stroops
      const observedDrift: bigint[] = [];
      const wouldLeak: bigint[] = [];
      for (let i = 0; i < proceeds.length; i++) {
        const p = proceeds[i]!;
        runningConserved += p - OBLIGATION;
        runningTruncating += (p / STROOPS_PER_MINOR - VALUE) * STROOPS_PER_MINOR;

        const { balanceMinor, carryStroops } = await runOneSlowRedemption(user, VALUE, p, i);
        const actualFloatStroops = balanceMinor * STROOPS_PER_MINOR + carryStroops;

        observedDrift.push(runningConserved - actualFloatStroops); // fixed: 0
        wouldLeak.push(runningConserved - runningTruncating); // grows
        expect(actualFloatStroops).toBe(runningConserved);
        // carry is a bounded sub-minor remainder at every step.
        expect(carryStroops).toBeGreaterThanOrEqual(0n);
        expect(carryStroops).toBeLessThan(STROOPS_PER_MINOR);
      }

      expect(observedDrift).toEqual([0n, 0n, 0n]); // fixed code: no drift
      expect(wouldLeak).toEqual([50_000n, 83_333n, 173_333n]); // truncating leak GROWS

      const { balanceMinor, carryStroops } = await readFloat();
      expect(balanceMinor).toBe(3n); // truncating code would leave 2
      expect(carryStroops).toBe(73_333n); // truncating code leaves 0
      expect(balanceMinor * STROOPS_PER_MINOR + carryStroops).toBe(373_333n);
    });
  },
);
