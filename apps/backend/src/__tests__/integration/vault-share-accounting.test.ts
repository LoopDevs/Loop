/**
 * ADR 031 §D4 (V5) — real-postgres coverage for the drift/solvency
 * queries the two new observability modules depend on:
 *
 *   1. `credits/vaults/vault-share-accounting.ts`'s three SQL sums
 *      (`sumEmittedTransferredShares` / `sumRedeemedCollectedShares` /
 *      `sumInFlightDepositedShares`) against REAL `vault_emissions` /
 *      `vault_redemptions` rows satisfying their real `state_shape`
 *      CHECK constraints — the mocked unit suites for
 *      `vault-drift-watcher.ts` / `hot-float-reconciliation.ts` stub
 *      these functions entirely, so only this suite proves the actual
 *      SQL filters the right rows.
 *   2. The `vault_float_reconciliation_runs` (migration 0063) insert
 *      round-trip — proves the schema/migration shape
 *      `hot-float-reconciliation.ts`'s `persistRun` writes actually
 *      matches what's committed (nullable numeric columns for the
 *      'error' state, the state/asset/network CHECKs).
 *
 * Gated on `LOOP_E2E_DB=1` like the sibling integration suites.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

import { db } from '../../db/client.js';
import {
  orders,
  vaultEmissions,
  vaultRedemptions,
  vaultFloatReconciliationRuns,
} from '../../db/schema.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';
import {
  sumEmittedTransferredShares,
  sumRedeemedCollectedShares,
  sumOffChainNetUserShares,
  sumOperatorHeldEmissionShares,
  sumOperatorHeldCollectedRedemptionShares,
  sumVaultMirrorLiabilityMinor,
} from '../../credits/vaults/vault-share-accounting.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

async function seedUser(): Promise<string> {
  const email = `vault-share-accounting-${crypto.randomUUID()}@test.local`;
  const user = await findOrCreateUserByEmail(email);
  return user.id;
}

async function seedOrder(userId: string): Promise<string> {
  const [order] = await db
    .insert(orders)
    .values({
      userId,
      merchantId: crypto.randomUUID(),
      faceValueMinor: 5000n,
      currency: 'USD',
      chargeMinor: 5000n,
      chargeCurrency: 'USD',
      paymentMethod: 'credit',
      wholesalePct: '70.00',
      userCashbackPct: '5.00',
      loopMarginPct: '25.00',
      wholesaleMinor: 3500n,
      userCashbackMinor: 250n,
      loopMarginMinor: 1250n,
      state: 'fulfilled',
    })
    .returning({ id: orders.id });
  return order!.id;
}

const WALLET_ADDRESS = Keypair.random().publicKey();

describeIf('vault-share-accounting integration — real postgres (ADR 031 V5)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  it('sums only transferred emissions and only collected redemptions, per (asset, network)', async () => {
    const userId = await seedUser();

    // A transferred LOOPUSD/testnet emission — counts.
    const order1 = await seedOrder(userId);
    await db.insert(vaultEmissions).values({
      orderId: order1,
      userId,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      cashbackMinor: 500n,
      toAddress: WALLET_ADDRESS,
      state: 'transferred',
      depositTxHash: 'deposit-tx-1',
      sharesMinted: 1_000_000n,
      transferTxHash: 'transfer-tx-1',
    });

    // A 'deposited' (not yet transferred) LOOPUSD/testnet emission — must NOT count toward transferred sum.
    const order2 = await seedOrder(userId);
    await db.insert(vaultEmissions).values({
      orderId: order2,
      userId,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      cashbackMinor: 300n,
      toAddress: WALLET_ADDRESS,
      state: 'deposited',
      depositTxHash: 'deposit-tx-2',
      sharesMinted: 300_000n,
    });

    // A transferred LOOPEUR/testnet emission — different asset, must not bleed into LOOPUSD's sum.
    const order3 = await seedOrder(userId);
    await db.insert(vaultEmissions).values({
      orderId: order3,
      userId,
      assetCode: 'LOOPEUR',
      network: 'testnet',
      cashbackMinor: 200n,
      toAddress: WALLET_ADDRESS,
      state: 'transferred',
      depositTxHash: 'deposit-tx-3',
      sharesMinted: 999_999n,
      transferTxHash: 'transfer-tx-3',
    });

    // A collected LOOPUSD/testnet redemption — counts against the transferred total.
    await db.insert(vaultRedemptions).values({
      sourceType: 'order_redeem',
      sourceId: order1,
      userId,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 100n,
      fromAddress: WALLET_ADDRESS,
      state: 'collecting',
      sharesToRedeem: 200_000n,
      collectTxHash: 'collect-tx-1',
    });

    // A 'pending' (not yet collected) LOOPUSD/testnet redemption — must NOT count.
    await db.insert(vaultRedemptions).values({
      sourceType: 'order_redeem',
      sourceId: order2,
      userId,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 50n,
      fromAddress: WALLET_ADDRESS,
      state: 'pending',
    });

    await expect(sumEmittedTransferredShares('LOOPUSD', 'testnet')).resolves.toBe(1_000_000n);
    await expect(sumRedeemedCollectedShares('LOOPUSD', 'testnet')).resolves.toBe(200_000n);
    await expect(sumOffChainNetUserShares('LOOPUSD', 'testnet')).resolves.toBe(800_000n);
    // Bucket (2): only the 'deposited' emission (300k) — the transferred
    // one is with the user, not the operator.
    await expect(sumOperatorHeldEmissionShares('LOOPUSD', 'testnet')).resolves.toBe(300_000n);
    // Bucket (3): the 'collecting' redemption with collect_tx_hash set +
    // payout_path NULL (200k). The 'pending' one hasn't collected.
    await expect(sumOperatorHeldCollectedRedemptionShares('LOOPUSD', 'testnet')).resolves.toBe(
      200_000n,
    );

    // LOOPEUR is untouched by the LOOPUSD redemption/deposited rows above.
    await expect(sumEmittedTransferredShares('LOOPEUR', 'testnet')).resolves.toBe(999_999n);
    await expect(sumRedeemedCollectedShares('LOOPEUR', 'testnet')).resolves.toBe(0n);

    // A different network for the same asset code sees none of this.
    await expect(sumEmittedTransferredShares('LOOPUSD', 'mainnet')).resolves.toBe(0n);
  });

  it('sumOperatorHeldEmissionShares counts failed-post-deposit rows but not failed-with-transfer-attempted or transferred rows', async () => {
    const userId = await seedUser();

    // Failed AFTER deposit landed, transfer never attempted (transfer_tx_hash NULL) — operator holds these, COUNTS.
    const o1 = await seedOrder(userId);
    await db.insert(vaultEmissions).values({
      orderId: o1,
      userId,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      cashbackMinor: 400n,
      toAddress: WALLET_ADDRESS,
      state: 'failed',
      depositTxHash: 'dep-fail-1',
      sharesMinted: 700_000n,
    });

    // Failed WITH a transfer attempted (transfer_tx_hash set) — ambiguous, EXCLUDED.
    const o2 = await seedOrder(userId);
    await db.insert(vaultEmissions).values({
      orderId: o2,
      userId,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      cashbackMinor: 400n,
      toAddress: WALLET_ADDRESS,
      state: 'failed',
      depositTxHash: 'dep-fail-2',
      sharesMinted: 111_111n,
      transferTxHash: 'xfer-attempted-2',
    });

    // Failed BEFORE deposit (deposit_tx_hash NULL) — operator holds nothing, EXCLUDED.
    const o3 = await seedOrder(userId);
    await db.insert(vaultEmissions).values({
      orderId: o3,
      userId,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      cashbackMinor: 400n,
      toAddress: WALLET_ADDRESS,
      state: 'failed',
    });

    await expect(sumOperatorHeldEmissionShares('LOOPUSD', 'testnet')).resolves.toBe(700_000n);
  });

  it('sumOperatorHeldCollectedRedemptionShares counts only collected rows with no payout path (collecting or failed-pre-payout)', async () => {
    const userId = await seedUser();

    // Collected, fast-path paid (payout_path='fast') — shares moved to the float pending count, EXCLUDED here.
    const r1 = await seedOrder(userId);
    await db.insert(vaultRedemptions).values({
      sourceType: 'order_redeem',
      sourceId: r1,
      userId,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 100n,
      fromAddress: WALLET_ADDRESS,
      state: 'redeemed',
      sharesToRedeem: 500_000n,
      collectTxHash: 'collect-fast',
      payoutPath: 'fast',
      redeemedAt: new Date(),
    });

    // Collected, terminally failed BEFORE any payout (payout_path NULL) — operator still holds, COUNTS.
    const r2 = await seedOrder(userId);
    await db.insert(vaultRedemptions).values({
      sourceType: 'order_redeem',
      sourceId: r2,
      userId,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 100n,
      fromAddress: WALLET_ADDRESS,
      state: 'failed',
      sharesToRedeem: 250_000n,
      collectTxHash: 'collect-failed',
    });

    await expect(sumOperatorHeldCollectedRedemptionShares('LOOPUSD', 'testnet')).resolves.toBe(
      250_000n,
    );
  });

  it('sumVaultMirrorLiabilityMinor = mirrored cashback minus settled redemption value, per (asset, network)', async () => {
    const userId = await seedUser();

    // Two mirrored emissions (credited the mirror): 500 + 300 = 800.
    for (const cashback of [500n, 300n]) {
      const o = await seedOrder(userId);
      await db.insert(vaultEmissions).values({
        orderId: o,
        userId,
        assetCode: 'LOOPUSD',
        network: 'testnet',
        cashbackMinor: cashback,
        toAddress: WALLET_ADDRESS,
        state: 'mirrored',
        depositTxHash: `dep-${cashback}`,
        sharesMinted: cashback * 1_000n,
        transferTxHash: `xfer-${cashback}`,
        mirroredAt: new Date(),
      });
    }

    // A NOT-yet-mirrored emission ('transferred') — must not count.
    const oNot = await seedOrder(userId);
    await db.insert(vaultEmissions).values({
      orderId: oNot,
      userId,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      cashbackMinor: 999n,
      toAddress: WALLET_ADDRESS,
      state: 'transferred',
      depositTxHash: 'dep-not',
      sharesMinted: 1n,
      transferTxHash: 'xfer-not',
    });

    // One settled redemption (debited the mirror by value_minor=120).
    const rSettled = await seedOrder(userId);
    await db.insert(vaultRedemptions).values({
      sourceType: 'order_redeem',
      sourceId: rSettled,
      userId,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 120n,
      fromAddress: WALLET_ADDRESS,
      state: 'settled',
      sharesToRedeem: 200_000n,
      collectTxHash: 'collect-settled',
      payoutPath: 'slow',
      redeemTxHash: 'redeem-settled',
      redeemedAt: new Date(),
      settledAt: new Date(),
    });

    // A not-yet-settled redemption ('redeemed') — must not count.
    const rNot = await seedOrder(userId);
    await db.insert(vaultRedemptions).values({
      sourceType: 'order_redeem',
      sourceId: rNot,
      userId,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      valueMinor: 77n,
      fromAddress: WALLET_ADDRESS,
      state: 'redeemed',
      sharesToRedeem: 100_000n,
      collectTxHash: 'collect-not',
      payoutPath: 'fast',
      redeemedAt: new Date(),
    });

    // 800 mirrored − 120 settled = 680.
    await expect(sumVaultMirrorLiabilityMinor('LOOPUSD', 'testnet')).resolves.toBe(680n);
    await expect(sumVaultMirrorLiabilityMinor('LOOPEUR', 'testnet')).resolves.toBe(0n);
  });

  it('returns 0n for every sum when no rows exist', async () => {
    await expect(sumEmittedTransferredShares('LOOPUSD', 'testnet')).resolves.toBe(0n);
    await expect(sumRedeemedCollectedShares('LOOPUSD', 'testnet')).resolves.toBe(0n);
    await expect(sumOffChainNetUserShares('LOOPUSD', 'testnet')).resolves.toBe(0n);
    await expect(sumOperatorHeldEmissionShares('LOOPUSD', 'testnet')).resolves.toBe(0n);
    await expect(sumOperatorHeldCollectedRedemptionShares('LOOPUSD', 'testnet')).resolves.toBe(0n);
    await expect(sumVaultMirrorLiabilityMinor('LOOPUSD', 'testnet')).resolves.toBe(0n);
  });

  it('round-trips a vault_float_reconciliation_runs row through the real migration-0063 schema (ok and error states)', async () => {
    await db.insert(vaultFloatReconciliationRuns).values({
      assetCode: 'LOOPUSD',
      network: 'testnet',
      operatorShareBalance: 1_000n,
      expectedOperatorShares: 1_000n,
      shareDelta: 0n,
      thresholdShares: 1_000_000n,
      state: 'ok',
      error: null,
    });
    await db.insert(vaultFloatReconciliationRuns).values({
      assetCode: 'LOOPEUR',
      network: 'testnet',
      operatorShareBalance: null,
      expectedOperatorShares: null,
      shareDelta: null,
      thresholdShares: 1_000_000n,
      state: 'error',
      error: 'RPC timeout',
    });

    const rows = await db.select().from(vaultFloatReconciliationRuns);
    expect(rows).toHaveLength(2);
    const ok = rows.find((r) => r.state === 'ok');
    const errored = rows.find((r) => r.state === 'error');
    expect(ok?.shareDelta).toBe(0n);
    expect(errored?.operatorShareBalance).toBeNull();
    expect(errored?.error).toBe('RPC timeout');
  });
});
