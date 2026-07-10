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
  },
  vaultClientMocks: {
    transferShares: vi.fn(async (args: { onSigned: (h: string) => Promise<void> | void }) => {
      const r = vaultClientState.transferResult ?? { txHash: 'default-collect-tx' };
      await args.onSigned(r.txHash);
      return { txHash: r.txHash, deduped: false };
    }),
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

// No real Privy call in a test — `collectSharesStep` only needs a
// non-null provider (the actual share transfer is fully mocked above,
// so nothing here ever calls `rawSign`).
vi.mock('../../wallet/provider.js', () => ({
  getWalletProvider: () => ({ name: 'privy' as const, createWallet: vi.fn(), rawSign: vi.fn() }),
}));

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
} from '../../db/schema.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';
import { computeLedgerDriftSql } from '../../credits/ledger-invariant.js';
import {
  claimVaultRedemption,
  driveOneVaultRedemption,
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
  await db.insert(userCredits).values({ userId, currency, balanceMinor: amountMinor });
  await db.insert(creditTransactions).values({
    userId,
    type: 'adjustment',
    amountMinor,
    currency,
    referenceType: null,
    referenceId: null,
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
});
