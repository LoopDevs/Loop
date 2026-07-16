/**
 * ADR 031 §D6 (V4) — vault-share REDEMPTION state machine, real
 * postgres (mirrors `__tests__/integration/vault-emissions.test.ts`'s
 * shape for the same class of reason).
 *
 * What ONLY a real DB can prove (the unit suite,
 * `credits/vaults/__tests__/vault-redemptions.test.ts`, mocks the
 * whole `db/client.js`):
 *
 *   1. `vault_redemptions_source_unique` actually fires as a real
 *      23505 on a genuine duplicate INSERT, not a hand-built fake.
 *   2. The mirror step's `pending_payouts kind='burn'` audit row goes
 *      through the REAL `assert_emission_conservation` trigger
 *      (migration 0044) without being rejected, and the REAL
 *      `pending_payouts_burn_order_unique` partial index is what its
 *      `onConflictDoNothing({target: pendingPayouts.orderId, where:
 *      kind='burn'})` actually targets.
 *   3. The `orders.pending_payment -> paid` transition
 *      (`markOrderPaidViaVaultRedemption`) and the `user_credits`
 *      debit land in the SAME real transaction as the burn row.
 *   4. The ledger-invariant `afterEach` assertion (hardening C7) — the
 *      vault redemption mirror step never desyncs `user_credits` from
 *      `credit_transactions`.
 *
 * Only `credits/vaults/vault-client.js` (the Soroban wire layer) and
 * `wallet/provider.js` (no real Privy call in a test) are mocked — no
 * network. `credits/vaults/registry.js` reads the REAL `loop_vaults`
 * row this suite inserts, `treasury/hot-float.ts` reads/writes the
 * REAL `vault_hot_float` table. Everything else (`db`,
 * `vault_redemptions`, `vault_hot_float`, `credit_transactions`,
 * `user_credits`, `pending_payouts`, `orders`, the trigger) is real
 * postgres.
 *
 * Gated on `LOOP_E2E_DB=1` like the sibling integration suites.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { Keypair, Address } from '@stellar/stellar-sdk';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

// Real strkey-shaped fixtures (56 chars, correct checksum) — the
// table's own CHECK constraints (`vault_redemptions_from_address_format`
// etc.) validate the shape, so a hand-typed placeholder of the wrong
// length fails the INSERT before anything this suite tests even runs.
const SHARE_CONTRACT_ID = Address.contract(Buffer.alloc(32, 4)).toString();
const VAULT_CONTRACT_ID = Address.contract(Buffer.alloc(32, 3)).toString();

// Only the Soroban wire layer is mocked (matches the V2/V3 unit
// suites' own posture) — collect/withdraw results are test-controlled.
const { vaultClientState, vaultClientMocks } = vi.hoisted(() => ({
  vaultClientState: {
    transferResult: null as null | { txHash: string },
    withdrawResult: null as null | { txHash: string; amountsOut: bigint[] },
    // MNY-06: the user's on-chain share holding `computeSharesToRedeem`
    // caps the collect at. Defaults far above any test's redemption so
    // `min(baseShares, held) === baseShares` (a partial); the full-balance
    // test overrides it to EXACTLY baseShares.
    shareBalance: 1_000_000_000_000n as bigint,
  },
  vaultClientMocks: {
    transferShares: vi.fn(
      async (args: { amount: bigint; onSigned: (h: string) => Promise<void> | void }) => {
        // Faithful on-chain SEP-41 reality: a transfer for MORE shares
        // than the holder has fails closed.
        if (args.amount > vaultClientState.shareBalance) {
          throw new Error(
            `transfer: insufficient share balance (amount=${args.amount} > held=${vaultClientState.shareBalance})`,
          );
        }
        const r = vaultClientState.transferResult ?? { txHash: 'default-collect-tx' };
        await args.onSigned(r.txHash);
        return { txHash: r.txHash, deduped: false };
      },
    ),
    withdrawFromVault: vi.fn(async (args: { onSigned: (h: string) => Promise<void> | void }) => {
      const r = vaultClientState.withdrawResult ?? {
        txHash: 'default-withdraw-tx',
        amountsOut: [60_000_000n],
      };
      await args.onSigned(r.txHash);
      return { txHash: r.txHash, amountsOut: r.amountsOut, deduped: false };
    }),
    readVaultState: vi.fn(async () => ({
      totalSupply: 1_000_000_000n,
      totalManaged: 1_000_000_000n,
      sharePricePpm: 1_000_000n,
    })),
    getShareBalance: vi.fn(async () => vaultClientState.shareBalance),
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
  getShareBalance: (...args: Parameters<typeof vaultClientMocks.getShareBalance>) =>
    vaultClientMocks.getShareBalance(...args),
  resolveOperatorPublicKey: () => vaultClientMocks.resolveOperatorPublicKey(),
}));

// No real Privy call in a test — `collectSharesStep` only needs a
// non-null provider (the actual share transfer is fully mocked above,
// so nothing here ever calls `rawSign`).
vi.mock('../../wallet/provider.js', () => ({
  getWalletProvider: () => ({ name: 'privy' as const, createWallet: vi.fn(), rawSign: vi.fn() }),
}));

// Mock ONLY the stuck-redemption notifier to a delivery-tracked stub (as
// the sibling emission suite mocks `notifyVaultEmissionsStuck`) so NO
// real Discord call happens and `notified===true` genuinely asserts the
// "delivered once, then don't re-page" behaviour. Every other
// `../../discord.js` export stays real via `...actual`.
vi.mock('../../discord.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    notifyVaultRedemptionsStuck: vi.fn(async () => true),
  };
});

import { db } from '../../db/client.js';
import {
  users,
  orders,
  loopVaults,
  vaultRedemptions,
  vaultHotFloat,
  pendingPayouts,
  userCredits,
  creditTransactions,
  watchdogAlertState,
} from '../../db/schema.js';
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
  runVaultRedemptionStuckWatchdog,
} from '../../credits/vaults/vault-redemptions.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

async function seedUser(): Promise<{ id: string; walletAddress: string }> {
  const email = `vault-redemption-${crypto.randomUUID()}@test.local`;
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

async function seedOrder(args: { userId: string; chargeMinor: bigint }): Promise<string> {
  const merchantId = crypto.randomUUID();
  const [order] = await db
    .insert(orders)
    .values({
      userId: args.userId,
      merchantId,
      faceValueMinor: args.chargeMinor,
      currency: 'USD',
      chargeMinor: args.chargeMinor,
      chargeCurrency: 'USD',
      paymentMethod: 'loop_asset',
      // orders_payment_memo_coherence (migration 0025): every
      // non-'credit'-method order must carry a non-null payment memo;
      // orders_payment_memo_unique also requires it be unique among
      // non-null memos, so a fresh id per seeded order is required.
      paymentMemo: `test-memo-${crypto.randomUUID()}`,
      wholesalePct: '70.00',
      userCashbackPct: '5.00',
      loopMarginPct: '25.00',
      wholesaleMinor: (args.chargeMinor * 70n) / 100n,
      userCashbackMinor: (args.chargeMinor * 5n) / 100n,
      loopMarginMinor: (args.chargeMinor * 25n) / 100n,
      state: 'pending_payment',
    })
    .returning({ id: orders.id });
  return order!.id;
}

/**
 * Seeds a `user_credits` balance WITH its backing `credit_transactions`
 * row (type='adjustment' — outside `credit_transactions_reference_unique`'s
 * scope) so the shared `afterEach` ledger-drift assertion stays green,
 * AND so the mirror step's debit has headroom to draw against without
 * tripping `user_credits`'s own non-negative CHECK.
 */
async function seedUserCreditsBalance(
  userId: string,
  currency: string,
  amountMinor: bigint,
): Promise<void> {
  // DAT-01-inv1 (migration 0066): the balance row and its backing
  // opening-balance ledger row must land in ONE transaction so the
  // deferred mirror-invariant trigger sees an EQUAL mirror at commit.
  // (Same shape as before — one adjustment ledger row of `amountMinor`
  // — just made atomic via the shared helper.)
  await seedUserCreditsWithBackingLedger(db, {
    userId,
    currency,
    balanceMinor: amountMinor,
    reason: 'integration-test fixture balance',
  });
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

/** Pre-funds the hot float so a redemption takes the FAST path. */
async function seedHotFloat(balanceMinor: bigint): Promise<void> {
  await db.insert(vaultHotFloat).values({
    assetCode: 'LOOPUSD',
    network: 'testnet',
    balanceMinor,
    pendingUnredeemedShares: 0n,
  });
}

describeIf('vault-redemptions integration — real postgres (ADR 031 V4)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
    vaultClientState.transferResult = null;
    vaultClientState.withdrawResult = null;
    vaultClientState.shareBalance = 1_000_000_000_000n;
    vaultClientMocks.transferShares.mockClear();
    vaultClientMocks.withdrawFromVault.mockClear();
    await seedVault();
  });

  // Hardening C7 (mirrors flywheel.test.ts / vault-emissions.test.ts):
  // the vault redemption mirror step must never desync user_credits
  // from credit_transactions.
  afterEach(async () => {
    const drift = await computeLedgerDriftSql(db);
    expect(drift).toEqual([]);
  });

  it('the full happy-path FAST redemption reaches settled, flips the order to paid, debits user_credits by exactly valueMinor, and writes a real burn row the conservation trigger accepts', async () => {
    const user = await seedUser();
    await seedUserCreditsBalance(user.id, 'USD', 10_000n);
    await seedHotFloat(5_000n); // covers the 500n redemption
    const orderId = await seedOrder({ userId: user.id, chargeMinor: 500n });

    const row = await claimVaultRedemption({
      sourceType: 'order_redeem',
      sourceId: orderId,
      userId: user.id,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 500n,
      fromAddress: user.walletAddress,
    });
    const outcome = await driveOneVaultRedemption(row);
    expect(outcome).toBe('settled');

    // orders.state really flipped, for real, via markOrderPaidViaVaultRedemption.
    const [freshOrder] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(freshOrder?.state).toBe('paid');
    expect(freshOrder?.paidAt).not.toBeNull();

    // user_credits debited by EXACTLY valueMinor (10_000 - 500).
    const [balance] = await db
      .select()
      .from(userCredits)
      .where(and(eq(userCredits.userId, user.id), eq(userCredits.currency, 'USD')));
    expect(balance?.balanceMinor).toBe(9_500n);

    const spendRows = await db
      .select()
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.userId, user.id),
          eq(creditTransactions.type, 'spend'),
          eq(creditTransactions.referenceId, orderId),
        ),
      );
    expect(spendRows).toHaveLength(1);
    expect(spendRows[0]).toMatchObject({ amountMinor: -500n, currency: 'USD' });

    // A real pending_payouts kind='burn' row exists and passed the
    // REAL assert_emission_conservation trigger (it would have thrown
    // a 23514 on insert otherwise — this insert already happened
    // inside driveOneVaultRedemption above, so reaching this point at
    // all is half the proof; the shape assertion below is the rest).
    const burnRows = await db
      .select()
      .from(pendingPayouts)
      .where(and(eq(pendingPayouts.userId, user.id), eq(pendingPayouts.kind, 'burn')));
    expect(burnRows).toHaveLength(1);
    expect(burnRows[0]).toMatchObject({
      orderId,
      assetCode: 'LOOPUSD',
      assetIssuer: SHARE_CONTRACT_ID,
      state: 'confirmed',
      amountStroops: 500n * 100_000n,
    });

    // Fast path really drew the float (not the slow synchronous withdraw).
    const [floatRow] = await db
      .select()
      .from(vaultHotFloat)
      .where(and(eq(vaultHotFloat.assetCode, 'LOOPUSD'), eq(vaultHotFloat.network, 'testnet')));
    expect(floatRow?.balanceMinor).toBe(5_000n - 500n);
    expect(floatRow?.pendingUnredeemedShares).toBeGreaterThan(0n);
    expect(vaultClientMocks.withdrawFromVault).not.toHaveBeenCalled();

    const [redemptionRow] = await db
      .select()
      .from(vaultRedemptions)
      .where(eq(vaultRedemptions.sourceId, orderId));
    expect(redemptionRow?.state).toBe('settled');
    expect(redemptionRow?.payoutPath).toBe('fast');
  });

  it('the full happy-path SLOW redemption (float empty) also reaches settled and flips the order to paid', async () => {
    const user = await seedUser();
    await seedUserCreditsBalance(user.id, 'USD', 10_000n);
    // No hot float seeded — starts at 0, forcing the slow synchronous withdraw.
    const orderId = await seedOrder({ userId: user.id, chargeMinor: 500n });
    vaultClientState.withdrawResult = { txHash: 'withdraw-tx-int-1', amountsOut: [52_000_000n] };

    const row = await claimVaultRedemption({
      sourceType: 'order_redeem',
      sourceId: orderId,
      userId: user.id,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 500n,
      fromAddress: user.walletAddress,
    });
    const outcome = await driveOneVaultRedemption(row);
    expect(outcome).toBe('settled');

    const [freshOrder] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(freshOrder?.state).toBe('paid');

    const [redemptionRow] = await db
      .select()
      .from(vaultRedemptions)
      .where(eq(vaultRedemptions.sourceId, orderId));
    expect(redemptionRow?.payoutPath).toBe('slow');
    expect(redemptionRow?.redeemTxHash).toBe('withdraw-tx-int-1');

    expect(vaultClientMocks.withdrawFromVault).toHaveBeenCalledTimes(1);
  });

  it('MNY-06 HEADLINE: a FULL-balance redemption (user holds EXACTLY baseShares) settles, collecting the ENTIRE holding — the +0.5% buffer used to make this fail closed (real postgres)', async () => {
    const user = await seedUser();
    await seedUserCreditsBalance(user.id, 'USD', 500n); // their WHOLE balance
    await seedHotFloat(5_000n); // fast payout
    const orderId = await seedOrder({ userId: user.id, chargeMinor: 500n });

    // The user holds EXACTLY baseShares: valueMinor 500 × PER at a 1:1
    // share price = 50_000_000 shares, and NOT one share more. Under the
    // old code, `computeSharesToRedeem` returned `baseShares + 0.5%`,
    // which the transfer mock (and a real vault) reject as an
    // over-collection → the redemption could never settle.
    const baseShares = 500n * 100_000n; // 50_000_000 at sharePricePpm 1:1
    vaultClientState.shareBalance = baseShares;

    const row = await claimVaultRedemption({
      sourceType: 'order_redeem',
      sourceId: orderId,
      userId: user.id,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 500n,
      fromAddress: user.walletAddress,
    });
    const outcome = await driveOneVaultRedemption(row);
    expect(outcome).toBe('settled');

    const [redemptionRow] = await db
      .select()
      .from(vaultRedemptions)
      .where(eq(vaultRedemptions.sourceId, orderId));
    expect(redemptionRow?.state).toBe('settled');
    // Collected the user's ENTIRE holding — position drained to zero, no
    // stranded share dust — and never more than they held.
    expect(redemptionRow?.sharesToRedeem).toBe(baseShares);

    // Order paid; user_credits debited by EXACTLY valueMinor (500 -> 0).
    const [freshOrder] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(freshOrder?.state).toBe('paid');
    const [balance] = await db
      .select()
      .from(userCredits)
      .where(and(eq(userCredits.userId, user.id), eq(userCredits.currency, 'USD')));
    expect(balance?.balanceMinor).toBe(0n);
  });

  it('MNY-06: a SLOW-path ADVERSE tick (proceeds within the 0.5% band, below valueMinor) DRAWS the float down — the real vault_hot_float_balance_non_negative CHECK accepts the negative delta', async () => {
    const user = await seedUser();
    await seedUserCreditsBalance(user.id, 'USD', 10_000n);
    await seedHotFloat(400n); // < valueMinor → slow path, but has balance to absorb a small draw-down
    const orderId = await seedOrder({ userId: user.id, chargeMinor: 500n });
    // Proceeds = 498 minor worth of stroops: 2 minor BELOW valueMinor,
    // inside the 0.5% band (min floor = 497.5 minor), so the withdraw
    // passes and the NEGATIVE net delta (-2) is applied to the float.
    vaultClientState.withdrawResult = {
      txHash: 'withdraw-tx-adverse',
      amountsOut: [498n * 100_000n],
    };

    const row = await claimVaultRedemption({
      sourceType: 'order_redeem',
      sourceId: orderId,
      userId: user.id,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 500n,
      fromAddress: user.walletAddress,
    });
    const outcome = await driveOneVaultRedemption(row);
    expect(outcome).toBe('settled'); // NOT rejected by the CHECK

    const [redemptionRow] = await db
      .select()
      .from(vaultRedemptions)
      .where(eq(vaultRedemptions.sourceId, orderId));
    expect(redemptionRow?.payoutPath).toBe('slow');

    // Real CHECK-constrained float: 400 + (498 - 500) = 398, still >= 0.
    const [floatRow] = await db
      .select()
      .from(vaultHotFloat)
      .where(and(eq(vaultHotFloat.assetCode, 'LOOPUSD'), eq(vaultHotFloat.network, 'testnet')));
    expect(floatRow?.balanceMinor).toBe(398n);

    // User still received EXACTLY valueMinor despite the shortfall.
    const [balance] = await db
      .select()
      .from(userCredits)
      .where(and(eq(userCredits.userId, user.id), eq(userCredits.currency, 'USD')));
    expect(balance?.balanceMinor).toBe(9_500n);
  });

  it('vault_redemptions_source_unique fires as a real 23505 on a genuine duplicate INSERT', async () => {
    const user = await seedUser();
    const orderId = await seedOrder({ userId: user.id, chargeMinor: 500n });

    await db.insert(vaultRedemptions).values({
      sourceType: 'order_redeem',
      sourceId: orderId,
      userId: user.id,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 500n,
      fromAddress: user.walletAddress,
    });

    await expect(
      db.insert(vaultRedemptions).values({
        sourceType: 'order_redeem',
        sourceId: orderId,
        userId: user.id,
        assetCode: 'LOOPUSD',
        network: 'testnet',
        valueMinor: 500n,
        fromAddress: user.walletAddress,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      const cause = (err as { cause?: { code?: string } }).cause;
      return cause?.code === '23505';
    });

    const rows = await db
      .select()
      .from(vaultRedemptions)
      .where(eq(vaultRedemptions.sourceId, orderId));
    expect(rows).toHaveLength(1);
  });

  it('claimVaultRedemption itself resolves a genuine duplicate claim to the SAME row (graceful onConflictDoNothing path, real postgres)', async () => {
    const user = await seedUser();
    const orderId = await seedOrder({ userId: user.id, chargeMinor: 500n });
    const args = {
      sourceType: 'order_redeem' as const,
      sourceId: orderId,
      userId: user.id,
      assetCode: 'LOOPUSD' as const,
      network: 'testnet' as const,
      valueMinor: 500n,
      fromAddress: user.walletAddress,
    };

    const first = await claimVaultRedemption(args);
    const second = await claimVaultRedemption(args);

    expect(second.id).toBe(first.id);
    const rows = await db
      .select()
      .from(vaultRedemptions)
      .where(eq(vaultRedemptions.sourceId, orderId));
    expect(rows).toHaveLength(1);
  });

  it('P2-3: a redemption whose source order EXPIRED before the mirror debit fails closed to `failed` and NEVER debits user_credits (real postgres)', async () => {
    const user = await seedUser();
    await seedUserCreditsBalance(user.id, 'USD', 10_000n);
    await seedHotFloat(5_000n); // covers the 500n redemption (fast payout path)
    const orderId = await seedOrder({ userId: user.id, chargeMinor: 500n });

    const row = await claimVaultRedemption({
      sourceType: 'order_redeem',
      sourceId: orderId,
      userId: user.id,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 500n,
      fromAddress: user.walletAddress,
    });

    // The source order expires (e.g. sweepExpiredOrders ran) before the
    // mirror debit — 'expired' is a valid orders.state per orders_state_known.
    await db.update(orders).set({ state: 'expired' }).where(eq(orders.id, orderId));

    const outcome = await driveOneVaultRedemption(row);
    expect(outcome).toBe('failed');

    // The order was NEVER flipped to paid.
    const [freshOrder] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(freshOrder?.state).toBe('expired');

    // user_credits UNCHANGED — the P2-3 not-payable throw rolled the mirror back.
    const [balance] = await db
      .select()
      .from(userCredits)
      .where(and(eq(userCredits.userId, user.id), eq(userCredits.currency, 'USD')));
    expect(balance?.balanceMinor).toBe(10_000n);

    // No spend row and no burn row were written.
    const spendRows = await db
      .select()
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.userId, user.id),
          eq(creditTransactions.type, 'spend'),
          eq(creditTransactions.referenceId, orderId),
        ),
      );
    expect(spendRows).toHaveLength(0);
    const burnRows = await db
      .select()
      .from(pendingPayouts)
      .where(and(eq(pendingPayouts.userId, user.id), eq(pendingPayouts.kind, 'burn')));
    expect(burnRows).toHaveLength(0);

    const [redemptionRow] = await db
      .select()
      .from(vaultRedemptions)
      .where(eq(vaultRedemptions.sourceId, orderId));
    expect(redemptionRow?.state).toBe('failed');
    expect(redemptionRow?.lastError).toMatch(/not payable|refund/i);
  });

  it('P1-B: a fresh collect_claimed_at lease blocks a second collect — claimCollect matches zero rows, transferShares is NOT re-invoked (real CAS)', async () => {
    const user = await seedUser();
    const orderId = await seedOrder({ userId: user.id, chargeMinor: 500n });

    const row = await claimVaultRedemption({
      sourceType: 'order_redeem',
      sourceId: orderId,
      userId: user.id,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 500n,
      fromAddress: user.walletAddress,
    });

    // Simulate a collect already claimed by a still-running driver: state
    // collecting, collect_claimed_at FRESH (NOW()), collected_at null.
    await db
      .update(vaultRedemptions)
      .set({ state: 'collecting', collectClaimedAt: new Date(), sharesToRedeem: 500_000n })
      .where(eq(vaultRedemptions.id, row.id));

    const [fresh] = await db.select().from(vaultRedemptions).where(eq(vaultRedemptions.id, row.id));
    const outcome = await driveOneVaultRedemption(fresh!);

    // Lost the (fresh, non-stale) claim → no forward progress, no transfer.
    expect(outcome).toBe('collecting');
    expect(vaultClientMocks.transferShares).not.toHaveBeenCalled();

    const [after] = await db.select().from(vaultRedemptions).where(eq(vaultRedemptions.id, row.id));
    expect(after?.state).toBe('collecting');
    expect(after?.collectedAt).toBeNull();
  });

  it('P1-B: two concurrent drives on the same collecting row collect AT MOST once, settle once, and debit exactly once (real CAS under Promise.all)', async () => {
    const user = await seedUser();
    await seedUserCreditsBalance(user.id, 'USD', 10_000n);
    await seedHotFloat(5_000n);
    const orderId = await seedOrder({ userId: user.id, chargeMinor: 500n });

    const row = await claimVaultRedemption({
      sourceType: 'order_redeem',
      sourceId: orderId,
      userId: user.id,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 500n,
      fromAddress: user.walletAddress,
    });
    // Move to collecting (UNclaimed) so both drivers genuinely race the
    // per-step collect_claimed_at CAS.
    await db
      .update(vaultRedemptions)
      .set({ state: 'collecting' })
      .where(eq(vaultRedemptions.id, row.id));
    const [fresh] = await db.select().from(vaultRedemptions).where(eq(vaultRedemptions.id, row.id));

    await Promise.all([driveOneVaultRedemption(fresh!), driveOneVaultRedemption(fresh!)]);

    // The collect CAS lets exactly one driver submit the user-signed transfer.
    expect(vaultClientMocks.transferShares.mock.calls.length).toBeLessThanOrEqual(1);

    const [after] = await db.select().from(vaultRedemptions).where(eq(vaultRedemptions.id, row.id));
    expect(after?.state).toBe('settled');

    // Debited exactly once — no double-collect/double-debit.
    const [balance] = await db
      .select()
      .from(userCredits)
      .where(and(eq(userCredits.userId, user.id), eq(userCredits.currency, 'USD')));
    expect(balance?.balanceMinor).toBe(9_500n);
    const spendRows = await db
      .select()
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.userId, user.id),
          eq(creditTransactions.type, 'spend'),
          eq(creditTransactions.referenceId, orderId),
        ),
      );
    expect(spendRows).toHaveLength(1);
  });

  // ─── ADR 031 V7 — admin re-drive support ────────────────────────────────

  it('V7: reclaims + redrives a failed-after-collect redemption to resume at payout WITHOUT re-collecting (real postgres CAS + FOR UPDATE lock)', async () => {
    const user = await seedUser();
    await seedUserCreditsBalance(user.id, 'USD', 10_000n);
    await seedHotFloat(0n); // insufficient — forces the SLOW path so payout can be made to fail independently of collect
    const orderId = await seedOrder({ userId: user.id, chargeMinor: 500n });
    vaultClientState.transferResult = { txHash: 'collect-tx-v7' };
    vaultClientMocks.withdrawFromVault.mockRejectedValueOnce(new Error('forced slow-path failure'));

    const claimed = await claimVaultRedemption({
      sourceType: 'order_redeem',
      sourceId: orderId,
      userId: user.id,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 500n,
      fromAddress: user.walletAddress,
    });

    // Drive once: the collect transfer LANDS (real collectedAt marker
    // set), the slow-path withdraw then fails — the row rests in
    // 'collecting' with attempts incremented, not yet terminal.
    const afterFirstDrive = await driveOneVaultRedemption(claimed);
    expect(afterFirstDrive).toBe('collecting');
    expect(vaultClientMocks.transferShares).toHaveBeenCalledTimes(1);
    const [midRow] = await db
      .select()
      .from(vaultRedemptions)
      .where(eq(vaultRedemptions.id, claimed.id));
    expect(midRow?.collectedAt).not.toBeNull();
    expect(midRow?.redeemedAt).toBeNull();

    // Simulate the row having exhausted VAULT_REDEMPTION_MAX_ATTEMPTS
    // (the unit suite already proves the real retry-counting path;
    // this integration test's focus is the real-DB reclaim + resume,
    // not re-driving 5 real attempts) — a genuinely `failed` row with
    // `collectedAt` set and `redeemedAt` still null.
    await db
      .update(vaultRedemptions)
      .set({ state: 'failed', attempts: 5, failedAt: new Date() })
      .where(eq(vaultRedemptions.id, claimed.id));

    const { reclaimFailedVaultRedemptionForRedrive } =
      await import('../../credits/vaults/vault-redemptions.js');
    const reclaimed = await reclaimFailedVaultRedemptionForRedrive(claimed.id);
    expect(reclaimed.kind).toBe('reclaimed');
    if (reclaimed.kind !== 'reclaimed') throw new Error('unreachable');
    // Real-DB proof of the resume-state inference: redeemedAt is still
    // null, so it resumes at 'collecting' (not blindly reset further
    // back) — the drive below then skips the already-landed collect.
    expect(reclaimed.row.state).toBe('collecting');
    expect(reclaimed.row.attempts).toBe(0);
    expect(reclaimed.row.collectClaimedAt).toBeNull();

    // The slow-path withdraw now succeeds (falls through the one-shot
    // rejection into the default resolved value).
    vaultClientState.withdrawResult = {
      txHash: 'withdraw-tx-v7',
      amountsOut: [500n * 100_000n],
    };
    vaultClientMocks.transferShares.mockClear();

    const finalOutcome = await driveOneVaultRedemption(reclaimed.row);

    expect(finalOutcome).toBe('settled');
    // The collect transfer was NEVER re-invoked on this resumed drive —
    // only the payout (+ mirror) steps ran.
    expect(vaultClientMocks.transferShares).not.toHaveBeenCalled();

    const [finalRow] = await db
      .select()
      .from(vaultRedemptions)
      .where(eq(vaultRedemptions.id, claimed.id));
    expect(finalRow?.state).toBe('settled');
    expect(finalRow?.payoutPath).toBe('slow');
    expect(finalRow?.collectTxHash).toBe('collect-tx-v7'); // untouched from the original collect

    const [finalOrder] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(finalOrder?.state).toBe('paid');
  });

  it('V7: isVaultRedemptionNeedsRefund detects a REAL needs-refund row (P2-3 path) and reclaimFailedVaultRedemptionForRedrive refuses it without mutating', async () => {
    const user = await seedUser();
    await seedUserCreditsBalance(user.id, 'USD', 10_000n);
    await seedHotFloat(5_000n);
    const orderId = await seedOrder({ userId: user.id, chargeMinor: 500n });

    const row = await claimVaultRedemption({
      sourceType: 'order_redeem',
      sourceId: orderId,
      userId: user.id,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 500n,
      fromAddress: user.walletAddress,
    });
    await db.update(orders).set({ state: 'expired' }).where(eq(orders.id, orderId));

    const outcome = await driveOneVaultRedemption(row);
    expect(outcome).toBe('failed'); // markRedemptionNeedsRefund's real terminal write

    const { isVaultRedemptionNeedsRefund, reclaimFailedVaultRedemptionForRedrive } =
      await import('../../credits/vaults/vault-redemptions.js');
    const [needsRefundRow] = await db
      .select()
      .from(vaultRedemptions)
      .where(eq(vaultRedemptions.id, row.id));
    expect(isVaultRedemptionNeedsRefund(needsRefundRow!)).toBe(true);

    const reclaimed = await reclaimFailedVaultRedemptionForRedrive(row.id);
    expect(reclaimed.kind).toBe('needs_refund');

    // Untouched — still failed, same attempts/lastError, never routed
    // toward a re-drive that would just fail identically again.
    const [unchanged] = await db
      .select()
      .from(vaultRedemptions)
      .where(eq(vaultRedemptions.id, row.id));
    expect(unchanged?.state).toBe('failed');
    expect(unchanged?.lastError).toBe(needsRefundRow?.lastError);
  });

  // ─── MNY-15 — stuck-redemption watchdog covers the `pending` strand ──────
  it('MNY-15: the stuck-redemption watchdog DETECTS + pages a stale `pending` strand (deregistered-vault case) but NOT a fresh pending row within the grace window — the state the old watchdog silently skipped', async () => {
    // A `pending` vault_redemptions row is a user-OWED redemption claimed
    // at `claimVaultRedemption` with nothing on-chain yet (source order
    // still `pending_payment`, `user_credits` not yet debited — the user
    // is owed their money-out). If its vault is deregistered,
    // `driveOneVaultRedemption` returns `no_vault` and leaves the row in
    // `pending` forever — a silent money-owed strand. The pre-fix
    // `VAULT_REDEMPTION_STUCK_STATES` (['collecting','redeemed']) excluded
    // `pending`, so the old watchdog found ZERO rows for it.
    const { notifyVaultRedemptionsStuck } = await import('../../discord.js');
    const notifyMock = vi.mocked(notifyVaultRedemptionsStuck);
    notifyMock.mockClear();

    // R1: the strand under test. R2: a co-resident FRESH pending row that
    // must NEVER be surfaced while it is within the grace window — proof
    // the staleness threshold, not merely the state, is the gate.
    const user1 = await seedUser();
    const order1 = await seedOrder({ userId: user1.id, chargeMinor: 500n });
    const r1 = await claimVaultRedemption({
      sourceType: 'order_redeem',
      sourceId: order1,
      userId: user1.id,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 500n,
      fromAddress: user1.walletAddress,
    });
    const user2 = await seedUser();
    const order2 = await seedOrder({ userId: user2.id, chargeMinor: 700n });
    await claimVaultRedemption({
      sourceType: 'order_redeem',
      sourceId: order2,
      userId: user2.id,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 700n,
      fromAddress: user2.walletAddress,
    });

    // Both are freshly `pending` (never CAS'd to collecting) — the shape a
    // strand leaves behind, and the shape a HEALTHY row briefly holds
    // before the next ~30s sweep advances it.
    const [pre1] = await db
      .select({ state: vaultRedemptions.state })
      .from(vaultRedemptions)
      .where(eq(vaultRedemptions.id, r1.id));
    expect(pre1?.state).toBe('pending');

    // Step 1 — GRACE WINDOW: both rows are seconds old, well inside the
    // 15-min threshold. The watchdog must find nothing and must NOT page:
    // a momentarily-`pending` healthy row is not a strand.
    const grace = await runVaultRedemptionStuckWatchdog({ thresholdMinutes: 15 });
    expect(grace.notified).toBe(false);
    expect(notifyMock).not.toHaveBeenCalled();
    const [alert0] = await db
      .select()
      .from(watchdogAlertState)
      .where(eq(watchdogAlertState.watchdogName, 'vault-redemption-stuck-watchdog'));
    expect(alert0?.alertActive ?? false).toBe(false);

    // Backdate ONLY R1 past the threshold (R2 stays fresh). This is the
    // sole change between step 1 and step 2 — same row, same `pending`
    // state, only its age crosses the line.
    await db
      .update(vaultRedemptions)
      .set({ createdAt: new Date(Date.now() - 30 * 60_000) })
      .where(eq(vaultRedemptions.id, r1.id));

    // Step 2 — DETECT + PAGE: the stale `pending` strand fires exactly
    // once. rowCount===1 proves the FRESH pending R2 was excluded even
    // while the watchdog was actively firing — the threshold, not the
    // state, drew the line.
    const first = await runVaultRedemptionStuckWatchdog({ thresholdMinutes: 15 });
    expect(first.notified).toBe(true);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0]?.[0]).toMatchObject({ states: 'pending', rowCount: 1 });
    const [alert1] = await db
      .select()
      .from(watchdogAlertState)
      .where(eq(watchdogAlertState.watchdogName, 'vault-redemption-stuck-watchdog'));
    expect(alert1?.alertActive).toBe(true);

    // Step 3 — FIRE-ONCE: the strand persists, but the latch holds — no
    // duplicate page.
    const second = await runVaultRedemptionStuckWatchdog({ thresholdMinutes: 15 });
    expect(second.notified).toBe(false);
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });
});
