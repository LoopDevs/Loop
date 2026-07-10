/**
 * LOOPUSD/LOOPEUR vault WITHDRAW/REDEEM state machine (ADR 031
 * §Detailed design D6, V4). Builds on the V1 registry (`registry.ts`),
 * the V2 Soroban client (`vault-client.ts` — `withdrawFromVault`, and
 * now `transferShares({ signWith: 'provider' })`), and V3's emission
 * flow (`vault-emissions.ts` — mirrored here for the state-CAS +
 * `FOR UPDATE SKIP LOCKED` + stuck-watchdog + Discord-paging +
 * `markWorkerTickFailure` patterns).
 *
 * ── The gated fork (`orders/redeem.ts`) ────────────────────────────
 * A gift-card purchase paid with the user's Loop balance
 * (`paymentMethod='loop_asset'`) goes down ONE of two mutually
 * exclusive redemption paths, decided at redeem-call time:
 *   - classic: the existing on-chain payment to the deposit address
 *     (`orders/redeem.ts`'s pre-existing flow), unchanged — the
 *     byte-identical default for GBPLOOP and for every currency while
 *     `LOOP_VAULTS_ENABLED` is off.
 *   - vault: this module, for USD/EUR orders when vaults are on. The
 *     classic flow's "pay LOOP-asset to the deposit address, let the
 *     Horizon-payment watcher match it" doesn't apply to Soroban vault
 *     shares (a share transfer targets the operator's account via a
 *     contract invocation, not a classic payment the watcher's
 *     Horizon payment stream observes) — so this module drives the
 *     whole redemption + the order's `pending_payment -> paid`
 *     transition directly, instead of relying on the payment watcher.
 *
 * ── State machine (§D6, migration 0062) ─────────────────────────────
 *   pending -> collecting -> redeemed -> settled  (+ failed)
 *
 *   1. pending      claimed (`claimVaultRedemption`), nothing on-chain
 *                    yet.
 *   1b. collecting  a drive CAS-claimed this row (`claimForCollecting`,
 *                    `pending -> collecting`, committed BEFORE any
 *                    on-chain call) — the cross-machine double-collect
 *                    guard, mirroring V3's `depositing`.
 *   2. (within      `computeSharesStep` persists `sharesToRedeem` from
 *      collecting)  a fresh share-price read + a small buffer (§D6
 *                    step 2) BEFORE any transfer is built — persisted
 *                    once, reused on every resume (never recomputed —
 *                    see the schema doc comment for why this differs
 *                    from `vault_emissions.min_shares_used`).
 *                    `collectSharesStep` then does the ONE user-wallet
 *                    signature in the whole vault system:
 *                    `transferShares({ signWith: 'provider' })`
 *                    (user's wallet -> operator). `payoutStep` then
 *                    pays out `value_minor` — FAST (hot float) or SLOW
 *                    (a synchronous `vault.withdraw`) — landing the row
 *                    on `redeemed`.
 *   3. redeemed     shares collected AND `value_minor` paid out.
 *                    `payout_path` + (for slow) `redeem_tx_hash`
 *                    persisted. INV-V2 (redemption solvency): the
 *                    slow-path payout is bounded below by
 *                    `value_minor` via `withdrawFromVault`'s
 *                    `minAmountsOut` floor — this row is NEVER marked
 *                    `redeemed` having paid out less than
 *                    `value_minor` is worth.
 *   4. settled      the off-chain `user_credits` liability is debited
 *                    by `value_minor` AND a `pending_payouts
 *                    kind='burn'` conservation-trigger audit row is
 *                    written — REUSING the EXISTING burn primitive
 *                    `orders/transitions.ts` already writes for
 *                    classic-asset redemptions (ADR 036), never a new
 *                    payout kind. For `source_type='order_redeem'` the
 *                    source order transitions `pending_payment ->
 *                    paid` in the SAME DB transaction
 *                    (`markOrderPaidViaVaultRedemption`).
 *   failed          terminal after `VAULT_REDEMPTION_MAX_ATTEMPTS`
 *                    consecutive step failures. NOT auto-retried —
 *                    pages Discord. No admin re-drive endpoint ships in
 *                    V4 (mirrors V3's same known gap).
 *
 * ── Conservation (INV-1) ────────────────────────────────────────────
 * The mirror debit + burn audit row go through the SAME
 * `assert_emission_conservation` trigger (migration 0044, currency-
 * scoped by migration 0061) the emission path is checked against — no
 * schema change needed (the trigger already sums `kind='burn'` rows by
 * `loop_asset_mirror_currency(asset_code)`, which migration 0061
 * already maps LOOPUSD/LOOPEUR into). `docs/invariants.md` INV-1/INV-2.
 *
 * ── At-most-once / recoverable partial states ──────────────────────
 * Every on-chain call threads CF-18 (persist the hash BEFORE
 * submitting), and every step function is individually idempotent on
 * its own persisted markers — see the schema doc comment
 * (`db/schema/vaults.ts`) for exactly which field marks which sub-step
 * done. A crash at any point resumes forward from `row.state` (+ the
 * sub-step markers within `collecting`), never re-running a step whose
 * marker is already set, and NEVER double-credits the hot float (the
 * payout step's float write and its own state transition commit in
 * ONE DB transaction — see `payoutStep`'s comment).
 *
 * ── Known cross-worker risk (NOT solved in V4, same class V3 flags) ──
 * `transferShares`/`withdrawFromVault` sign with the SAME
 * `LOOP_STELLAR_OPERATOR_SECRET` the classic payout-submit worker and
 * the V3 emission sweep use. This module's own sweep processes rows
 * strictly sequentially (never concurrent submits from within this
 * module) but does not coordinate sequence numbers with those other
 * workers — see `vault-emissions.ts`'s module header for the full
 * note, which applies identically here.
 *
 * ── Known residual race (accepted, self-correcting) ─────────────────
 * `driveOneVaultRedemption` is deliberately callable from BOTH
 * `orders/redeem.ts`'s inline drive AND this module's sweep — the
 * `pending -> collecting` CAS makes that safe for the collect step,
 * and `payoutStep`'s guarded `WHERE state='collecting'` UPDATE (rolled
 * back together with its float write via `PayoutAlreadyLandedError`
 * when the guard misses) makes a LANDED payout safe against double-
 * crediting the float. What is NOT fully serialized: if two drivers
 * both read the row at `redeemTxHash === null` and BOTH independently
 * fail the fast-path draw (float insufficient for both), both can
 * proceed to build a REAL on-chain `withdrawFromVault` for the SAME
 * `sharesToRedeem` before either commits. DeFindex's vault contract
 * cannot burn more shares than the operator holds, so the LOSER's
 * on-chain call fails (a `terminal_contract_error`-shaped failure,
 * `recordStepFailure`'s normal retry path) rather than double-paying —
 * a wasted Soroban tx + a retry, not a fund-loss or a double-pay. A
 * per-row advisory lock around the WHOLE payout step (not just the
 * float write) would close this fully; deferred as a V5 tightening,
 * flagged explicitly for money-review.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db, withAdvisoryLock } from '../../db/client.js';
import {
  vaultRedemptions,
  creditTransactions,
  userCredits,
  pendingPayouts,
  watchdogAlertState,
  type LoopVaultAssetCode,
  type LoopVaultNetwork,
  type VaultRedemptionSourceType,
} from '../../db/schema.js';
import { logger } from '../../logger.js';
import { isUniqueViolation } from '../../db/errors.js';
import { getUserById } from '../../db/users.js';
import { getWalletProvider } from '../../wallet/provider.js';
import {
  markWorkerStarted,
  markWorkerStopped,
  markWorkerTickFailure,
  markWorkerTickSuccess,
} from '../../runtime-health.js';
import { notifyVaultRedemptionFailed, notifyVaultRedemptionsStuck } from '../../discord.js';
import { getActiveVault, vaultsEnabled, type LoopVaultRow } from './registry.js';
import {
  transferShares,
  withdrawFromVault,
  readVaultState,
  resolveOperatorPublicKey,
} from './vault-client.js';
import { generatePayoutMemo } from '../payout-builder.js';
import { markOrderPaidViaVaultRedemption } from '../../orders/transitions.js';
import {
  drawHotFloatInTx,
  applyHotFloatDeltaInTx,
  runHotFloatReplenishTick,
} from '../../treasury/hot-float.js';
import {
  isVaultEligibleCurrency,
  vaultAssetForCurrency,
  currentVaultNetwork,
} from './vault-emissions.js';

const log = logger.child({ area: 'vault-redemptions' });

export type VaultRedemptionRow = typeof vaultRedemptions.$inferSelect;

/** Same 7-decimal convention every vault module uses (`credits/vaults/vault-emissions.ts`). */
const STROOPS_PER_MINOR = 100_000n;

/** Consecutive step failures before a row moves `-> 'failed'`. Mirrors `VAULT_EMISSION_MAX_ATTEMPTS`. */
export const VAULT_REDEMPTION_MAX_ATTEMPTS = 5;

/** Buffer added to the computed share count so a small adverse share-price move between quote and collect still covers `value_minor` (ADR 031 §D6 step 2). */
const REDEMPTION_SHARE_BUFFER_BPS = 50n; // 0.5%

// Re-export the V3 helpers this module shares (same currency <-> asset mapping, no drift risk).
export { isVaultEligibleCurrency, vaultAssetForCurrency, currentVaultNetwork };

export interface ClaimVaultRedemptionArgs {
  sourceType: VaultRedemptionSourceType;
  sourceId: string;
  userId: string;
  assetCode: LoopVaultAssetCode;
  network: LoopVaultNetwork;
  /** Value being redeemed, in the vault currency's minor units. Must be > 0 (the table's own CHECK also enforces this). */
  valueMinor: bigint;
  fromAddress: string;
}

/**
 * ADR 031 §D6 step 1 — the durable idempotency claim. Standalone (own
 * transaction) — unlike V3's `claimVaultEmission`, there is no
 * natural single order-state transition to piggyback on here (the
 * order stays `pending_payment` throughout collection), so this opens
 * its own short transaction. Reuses the existing row on a repeat call
 * for the SAME `(sourceType, sourceId)` rather than erroring — a
 * re-tapped redeem button resolves to the same in-flight row.
 */
export async function claimVaultRedemption(
  args: ClaimVaultRedemptionArgs,
): Promise<VaultRedemptionRow> {
  const inserted = await db
    .insert(vaultRedemptions)
    .values({
      sourceType: args.sourceType,
      sourceId: args.sourceId,
      userId: args.userId,
      assetCode: args.assetCode,
      network: args.network,
      valueMinor: args.valueMinor,
      fromAddress: args.fromAddress,
      state: 'pending',
    })
    .onConflictDoNothing({ target: [vaultRedemptions.sourceType, vaultRedemptions.sourceId] })
    .returning();
  if (inserted[0] !== undefined) return inserted[0];

  const [existing] = await db
    .select()
    .from(vaultRedemptions)
    .where(
      and(
        eq(vaultRedemptions.sourceType, args.sourceType),
        eq(vaultRedemptions.sourceId, args.sourceId),
      ),
    );
  if (existing === undefined) {
    throw new Error(
      `vault_redemptions row missing after a claim conflict (sourceType=${args.sourceType}, sourceId=${args.sourceId})`,
    );
  }
  return existing;
}

/**
 * Cross-machine collect claim. Atomic state-CAS `pending -> collecting`,
 * committed before any Soroban call — mirrors `vault-emissions.ts`'s
 * `claimEmissionForDeposit` exactly.
 */
async function claimForCollecting(id: string): Promise<VaultRedemptionRow | null> {
  const [row] = await db
    .update(vaultRedemptions)
    .set({ state: 'collecting' })
    .where(and(eq(vaultRedemptions.id, id), eq(vaultRedemptions.state, 'pending')))
    .returning();
  return row ?? null;
}

async function recordStepFailure(
  row: VaultRedemptionRow,
  err: unknown,
): Promise<VaultRedemptionRow> {
  const attempts = row.attempts + 1;
  const lastError = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
  const terminal = attempts >= VAULT_REDEMPTION_MAX_ATTEMPTS;
  const [updated] = await db
    .update(vaultRedemptions)
    .set({
      attempts,
      lastError,
      ...(terminal ? { state: 'failed' as const, failedAt: new Date() } : {}),
    })
    .where(eq(vaultRedemptions.id, row.id))
    .returning();
  log.error(
    {
      err,
      vaultRedemptionId: row.id,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      attempts,
      terminal,
    },
    'vault redemption step failed',
  );
  if (updated === undefined) {
    throw new Error(`vault_redemptions update returned no row (id=${row.id})`);
  }
  if (terminal) {
    notifyVaultRedemptionFailed({
      vaultRedemptionId: updated.id,
      sourceType: updated.sourceType,
      sourceId: updated.sourceId,
      userId: updated.userId,
      assetCode: updated.assetCode,
      valueMinor: updated.valueMinor.toString(),
      attempts,
      lastError,
    });
  }
  return updated;
}

/** A fresh, bounded share count for `valueMinor` — a live `readVaultState` price + a small buffer (ADR 031 §D6 step 2), never 0. */
async function computeSharesToRedeem(vault: LoopVaultRow, valueMinor: bigint): Promise<bigint> {
  const state = await readVaultState({ vault });
  const underlyingStroops = valueMinor * STROOPS_PER_MINOR;
  const baseShares = (underlyingStroops * 1_000_000n) / state.sharePricePpm;
  const buffered = baseShares + (baseShares * REDEMPTION_SHARE_BUFFER_BPS) / 10_000n;
  const sharesToRedeem = buffered > baseShares ? buffered : baseShares + 1n;
  if (sharesToRedeem <= 0n) {
    throw new Error(
      `computeSharesToRedeem: computed non-positive sharesToRedeem (${sharesToRedeem}) for valueMinor=${valueMinor}, sharePricePpm=${state.sharePricePpm}`,
    );
  }
  return sharesToRedeem;
}

async function computeSharesStep(
  row: VaultRedemptionRow,
  vault: LoopVaultRow,
): Promise<VaultRedemptionRow> {
  try {
    const sharesToRedeem = await computeSharesToRedeem(vault, row.valueMinor);
    const [updated] = await db
      .update(vaultRedemptions)
      .set({ sharesToRedeem })
      .where(eq(vaultRedemptions.id, row.id))
      .returning();
    if (updated === undefined) {
      throw new Error(
        `vault_redemptions update returned no row (id=${row.id}, compute-shares step)`,
      );
    }
    return updated;
  } catch (err) {
    return recordStepFailure(row, err);
  }
}

/**
 * ADR 031 §D1 — the ONE user-wallet signature. Resumable via its own
 * `collectTxHash` marker (checked first — a resume never re-signs).
 */
async function collectSharesStep(
  row: VaultRedemptionRow,
  vault: LoopVaultRow,
): Promise<VaultRedemptionRow> {
  if (row.collectTxHash !== null) {
    if (row.collectedAt !== null) return row;
    const [updated] = await db
      .update(vaultRedemptions)
      .set({ collectedAt: new Date() })
      .where(eq(vaultRedemptions.id, row.id))
      .returning();
    return updated ?? row;
  }
  try {
    if (row.sharesToRedeem === null) {
      throw new Error(
        `invariant: vault redemption ${row.id} has no sharesToRedeem at collect step`,
      );
    }
    const user = await getUserById(row.userId);
    if (user === null || user.walletId === null || user.walletAddress === null) {
      throw new Error(
        `vault redemption ${row.id}: user ${row.userId} has no activated embedded wallet`,
      );
    }
    const provider = getWalletProvider();
    if (provider === null) {
      throw new Error(
        'vault redemption collect step: wallet provider is not configured (LOOP_WALLET_PROVIDER unset)',
      );
    }
    const result = await transferShares({
      vault,
      from: row.fromAddress,
      to: resolveOperatorPublicKey(),
      amount: row.sharesToRedeem,
      signWith: 'provider',
      userWallet: { provider, walletId: user.walletId },
      onSigned: async (txHash) => {
        // CF-18: persist BEFORE the user-sign + submit round trip.
        await db
          .update(vaultRedemptions)
          .set({ collectTxHash: txHash })
          .where(eq(vaultRedemptions.id, row.id));
      },
    });
    const [updated] = await db
      .update(vaultRedemptions)
      .set({ collectTxHash: result.txHash, collectedAt: new Date() })
      .where(eq(vaultRedemptions.id, row.id))
      .returning();
    if (updated === undefined) {
      throw new Error(`vault_redemptions update returned no row (id=${row.id}, collect step)`);
    }
    return updated;
  } catch (err) {
    return recordStepFailure(row, err);
  }
}

/**
 * ADR 031 §D6 step 3 — pay out `value_minor`. FAST (hot float) if it
 * covers the amount; otherwise SLOW (a synchronous `vault.withdraw`).
 *
 * Both branches land the float write AND this row's `-> 'redeemed'`
 * transition in ONE DB transaction (`drawHotFloatInTx` / a direct
 * `applyHotFloatDeltaInTx` call, both given the SAME `tx` this
 * function's own guarded `UPDATE vault_redemptions ... WHERE
 * state='collecting'` runs in) — this is load-bearing for at-most-once:
 * without it, a crash between "float credited" and "row transitioned"
 * would make a resume redo the float write (a double-credit on the
 * slow path) or re-attempt the draw (a double-draw on the fast path).
 * Atomicity means a resume either sees the FULL prior landing (row
 * already `redeemed`, this function is never re-entered) or NONE of it
 * (both roll back together, safe to redo from scratch — the on-chain
 * `withdrawFromVault` call itself still dedupes via its own
 * `redeemTxHash`-keyed CF-18 fence).
 *
 * Once a SLOW-path withdraw has been STARTED (`redeemTxHash !== null`
 * from a prior attempt's `onSigned`), this function commits to
 * finishing the slow path rather than re-trying the fast path — a
 * fast-path draw here would leave the already-submitted withdraw's
 * proceeds permanently uncredited (an orphaned float short), so once
 * `redeemTxHash` is set the fast-path branch is skipped entirely.
 */
/**
 * Thrown INSIDE a payout transaction to force a rollback (undoing the
 * float write together with it) when the guarded `vault_redemptions`
 * UPDATE finds no matching row — i.e. a concurrent driver (the HTTP
 * handler's inline drive racing the background sweep — both are
 * legitimately allowed to call `driveOneVaultRedemption` on the same
 * row, see its doc comment) already landed the transition first. A
 * bare "return null without throwing" would let the float write
 * COMMIT anyway (Drizzle only rolls back on a thrown error), silently
 * double-crediting/double-drawing the float — this sentinel exists so
 * that never happens.
 */
class PayoutAlreadyLandedError extends Error {}

async function payoutStep(
  row: VaultRedemptionRow,
  vault: LoopVaultRow,
): Promise<VaultRedemptionRow> {
  try {
    if (row.sharesToRedeem === null) {
      throw new Error(`invariant: vault redemption ${row.id} has no sharesToRedeem at payout step`);
    }
    const assetCode = vault.assetCode as LoopVaultAssetCode;
    const network = vault.network as LoopVaultNetwork;
    const sharesToRedeem = row.sharesToRedeem;

    if (row.redeemTxHash === null) {
      let fastResult: VaultRedemptionRow | null;
      try {
        fastResult = await db.transaction(async (tx) => {
          const drew = await drawHotFloatInTx(
            tx,
            assetCode,
            network,
            row.valueMinor,
            sharesToRedeem,
          );
          if (!drew) return null;
          const [updated] = await tx
            .update(vaultRedemptions)
            .set({ state: 'redeemed', payoutPath: 'fast', redeemedAt: new Date() })
            .where(and(eq(vaultRedemptions.id, row.id), eq(vaultRedemptions.state, 'collecting')))
            .returning();
          if (updated === undefined) throw new PayoutAlreadyLandedError();
          return updated;
        });
      } catch (err) {
        if (err instanceof PayoutAlreadyLandedError) {
          fastResult = null;
        } else {
          throw err;
        }
      }
      if (fastResult !== null) return fastResult;
      // fastResult null here means EITHER the float didn't cover it
      // (fall through to slow path below) OR another driver already
      // landed the transition (PayoutAlreadyLandedError, float draw
      // rolled back) — in the latter case the row is already
      // 'redeemed'/beyond, so the slow-path branch below will itself
      // see `row.redeemTxHash === null` still (this row snapshot is
      // stale) and attempt a real withdraw against a row whose shares
      // are already spent. Guard against that by re-reading first.
      const [fresh] = await db
        .select()
        .from(vaultRedemptions)
        .where(eq(vaultRedemptions.id, row.id));
      if (fresh === undefined) {
        throw new Error(`vault_redemptions row ${row.id} vanished mid-payout step`);
      }
      if (fresh.state !== 'collecting') return fresh;
    }

    // SLOW path — the float couldn't cover it (or a prior attempt
    // already committed to this path). `minAmountsOut` is INV-V2's
    // floor: `withdrawFromVault` throws `VaultPostSubmitSlippageError`
    // rather than let this row be marked `redeemed` for less than
    // `value_minor` is worth.
    const minAmountsOut = row.valueMinor * STROOPS_PER_MINOR;
    const result = await withdrawFromVault({
      vault,
      shares: sharesToRedeem,
      minAmountsOut,
      ...(row.redeemTxHash !== null ? { priorTxHash: row.redeemTxHash } : {}),
      onSigned: async (txHash) => {
        await db
          .update(vaultRedemptions)
          .set({ redeemTxHash: txHash })
          .where(eq(vaultRedemptions.id, row.id));
      },
    });
    const amountOutStroops = result.amountsOut[0];
    if (amountOutStroops === undefined) {
      throw new Error(`vault redemption ${row.id}: withdrawFromVault returned an empty amountsOut`);
    }
    const amountOutMinor = amountOutStroops / STROOPS_PER_MINOR;
    // Guaranteed >= 0 by the minAmountsOut floor above.
    const netFloatDelta = amountOutMinor - row.valueMinor;

    try {
      return await db.transaction(async (tx) => {
        await applyHotFloatDeltaInTx(tx, assetCode, network, netFloatDelta, 0n);
        const [updated] = await tx
          .update(vaultRedemptions)
          .set({ state: 'redeemed', payoutPath: 'slow', redeemedAt: new Date() })
          .where(and(eq(vaultRedemptions.id, row.id), eq(vaultRedemptions.state, 'collecting')))
          .returning();
        if (updated === undefined) throw new PayoutAlreadyLandedError();
        return updated;
      });
    } catch (err) {
      if (!(err instanceof PayoutAlreadyLandedError)) throw err;
      // Another driver already landed the transition — the float
      // credit above rolled back with the rest of this transaction
      // (the thrown sentinel forces Postgres to roll back, so nothing
      // was double-counted). The on-chain withdraw itself already
      // landed regardless (its proceeds are safe — a future retry of
      // THIS row would dedupe via `redeemTxHash`'s CF-18 fence, but
      // this row won't be retried again since it's already past
      // 'collecting'); re-read the current state and return it.
      const [fresh] = await db
        .select()
        .from(vaultRedemptions)
        .where(eq(vaultRedemptions.id, row.id));
      if (fresh === undefined) {
        throw new Error(`vault_redemptions row ${row.id} vanished mid-payout step`);
      }
      return fresh;
    }
  } catch (err) {
    return recordStepFailure(row, err);
  }
}

/**
 * ADR 036 — extinguish both halves. Debits `user_credits` by
 * `value_minor` and writes a `pending_payouts kind='burn'` audit row
 * — the EXISTING primitive `orders/transitions.ts` writes for classic
 * redemptions, reused verbatim (no new payout kind). For
 * `source_type='order_redeem'`, transitions the source order
 * `pending_payment -> paid` in the SAME transaction.
 */
async function mirrorStep(
  row: VaultRedemptionRow,
  vault: LoopVaultRow,
): Promise<VaultRedemptionRow> {
  try {
    if (row.sharesToRedeem === null || row.collectTxHash === null || row.payoutPath === null) {
      throw new Error(
        `invariant: vault redemption ${row.id} is 'redeemed' with missing sharesToRedeem/collectTxHash/payoutPath`,
      );
    }
    const currency = vault.assetCode === 'LOOPUSD' ? 'USD' : 'EUR';

    let pendingPayoutId: string | null = null;
    let orderTransitioned = true;
    try {
      await db.transaction(async (tx) => {
        // Lock-then-write (INV-2) — the SAME discipline every other
        // `credits/` primitive uses.
        await tx
          .select()
          .from(userCredits)
          .where(and(eq(userCredits.userId, row.userId), eq(userCredits.currency, currency)))
          .for('update');

        await tx.insert(creditTransactions).values({
          userId: row.userId,
          type: 'spend',
          amountMinor: -row.valueMinor,
          currency,
          referenceType: 'order',
          referenceId: row.sourceId,
        });
        await tx
          .update(userCredits)
          .set({ balanceMinor: sql`${userCredits.balanceMinor} - ${row.valueMinor}` })
          .where(and(eq(userCredits.userId, row.userId), eq(userCredits.currency, currency)));

        // Conservation-trigger audit row (INV-1) — the collected
        // shares are the on-chain "burn" (they left the user's wallet
        // via the collect step and were either redeemed from the
        // vault or sit as pending-unredeemed operator shares —
        // amount_stroops here is VALUE-denominated, matching the
        // emission mirror step's convention, not share-denominated).
        const [payout] = await tx
          .insert(pendingPayouts)
          .values({
            userId: row.userId,
            orderId: row.sourceType === 'order_redeem' ? row.sourceId : null,
            kind: 'burn',
            assetCode: vault.assetCode,
            assetIssuer: vault.shareAssetIssuer,
            toAddress: resolveOperatorPublicKey(),
            amountStroops: row.valueMinor * STROOPS_PER_MINOR,
            memoText: generatePayoutMemo(),
            state: 'confirmed',
            txHash: row.collectTxHash,
            submittedAt: new Date(),
            confirmedAt: new Date(),
          })
          .onConflictDoNothing({
            target: pendingPayouts.orderId,
            where: sql`kind = 'burn'`,
          })
          .returning({ id: pendingPayouts.id });
        pendingPayoutId = payout?.id ?? null;

        if (row.sourceType === 'order_redeem') {
          const paid = await markOrderPaidViaVaultRedemption(tx, row.sourceId);
          orderTransitioned = paid !== null;
        }
      });
    } catch (err) {
      if (isUniqueViolation(err, 'credit_transactions_reference_unique')) {
        log.warn(
          { vaultRedemptionId: row.id, sourceId: row.sourceId },
          'vault redemption mirror step: credit_transactions row already exists — treating as already-mirrored',
        );
      } else {
        throw err;
      }
    }

    if (!orderTransitioned) {
      log.warn(
        { vaultRedemptionId: row.id, sourceId: row.sourceId },
        'vault redemption mirror step: source order was not in pending_payment at transition time (already paid, or a state mismatch) — mirror still recorded',
      );
    }

    const [updated] = await db
      .update(vaultRedemptions)
      .set({
        state: 'settled',
        settledAt: new Date(),
        ...(pendingPayoutId !== null ? { pendingPayoutId } : {}),
      })
      .where(eq(vaultRedemptions.id, row.id))
      .returning();
    if (updated === undefined) {
      throw new Error(`vault_redemptions update returned no row (id=${row.id}, mirror step)`);
    }
    return updated;
  } catch (err) {
    return recordStepFailure(row, err);
  }
}

export type VaultRedemptionDriveOutcome =
  | 'collecting'
  | 'redeemed'
  | 'settled'
  | 'failed'
  | 'no_vault'
  | 'claimed_elsewhere';

/**
 * Advances one `vault_redemptions` row as far as it will go THIS call
 * — resumes from `row.state` (+ its sub-step markers), never re-runs a
 * completed step. Safe to call from both the HTTP redeem handler
 * (`orders/redeem.ts`, for a fast synchronous best-effort drive) and
 * the sweep below (crash recovery / the primary driver when the
 * inline drive didn't finish) — the `pending -> collecting` CAS makes
 * concurrent callers safe.
 */
export async function driveOneVaultRedemption(
  row: VaultRedemptionRow,
): Promise<VaultRedemptionDriveOutcome> {
  const vault = await getActiveVault(
    row.assetCode as LoopVaultAssetCode,
    row.network as LoopVaultNetwork,
  );
  if (vault === null) {
    log.error(
      { vaultRedemptionId: row.id, assetCode: row.assetCode, network: row.network },
      'vault redemption: no active vault registered for this (asset, network) — row stays as-is for a future retry',
    );
    return 'no_vault';
  }

  let current = row;
  if (current.state === 'pending') {
    const claimed = await claimForCollecting(current.id);
    if (claimed === null) return 'claimed_elsewhere';
    current = claimed;
  }
  if (current.state === 'collecting') {
    if (current.sharesToRedeem === null) {
      current = await computeSharesStep(current, vault);
    }
    if (current.state === 'collecting' && current.sharesToRedeem !== null) {
      current = await collectSharesStep(current, vault);
    }
    if (current.state === 'collecting' && current.collectTxHash !== null) {
      current = await payoutStep(current, vault);
    }
  }
  if (current.state === 'redeemed') {
    current = await mirrorStep(current, vault);
  }
  return current.state as VaultRedemptionDriveOutcome;
}

/**
 * Drives a row through as many steps as land within `maxSteps` drive
 * calls (each call can advance multiple internal sub-steps in one
 * pass, so this is a generous synchronous budget, not a per-network-
 * call count). Used by `orders/redeem.ts` for a best-effort inline
 * settle so a fast (hot-float) redemption can complete within the
 * HTTP request; the background sweep below is the crash-recovery /
 * eventual-completion guarantee regardless of what this returns.
 */
export async function driveVaultRedemptionToCompletion(
  row: VaultRedemptionRow,
  maxSteps = 4,
): Promise<VaultRedemptionRow> {
  let current = row;
  for (let i = 0; i < maxSteps; i++) {
    const outcome = await driveOneVaultRedemption(current);
    // Bugfix (test-authoring pass): always re-read the row BEFORE
    // deciding whether to stop, even on a terminal outcome. The
    // previous code `break`d immediately on 'settled'/'failed'/
    // 'no_vault' WITHOUT ever re-fetching, so a row that reached a
    // terminal state on its very first drive call (the common case —
    // a fast hot-float redemption settles in one `driveOneVaultRedemption`
    // pass) returned the STALE pre-drive snapshot (e.g. still showing
    // state='pending') instead of the real 'settled'/'failed' row.
    // `orders/redeem-vault.ts` checks `settled.state === 'failed'` on
    // this return value to decide whether to surface a 500 — with the
    // stale row that check silently never fired, so a genuinely failed
    // redemption could return a 200 with the order still
    // `pending_payment` instead of the intended terminal error.
    const [fresh] = await db
      .select()
      .from(vaultRedemptions)
      .where(eq(vaultRedemptions.id, current.id));
    if (fresh === undefined) break;
    const noForwardProgress = fresh.state === current.state && fresh.attempts === current.attempts;
    current = fresh;
    if (outcome === 'settled' || outcome === 'failed' || outcome === 'no_vault') break;
    if (noForwardProgress) {
      // No forward progress this pass (e.g. lost the CAS to a
      // concurrent sweep) — stop spinning inline, let the sweep finish it.
      break;
    }
  }
  return current;
}

// ─── Sweep (crash-recovery + primary driver — mirrors vault-emissions.ts) ────

const SWEEP_STATES = ['pending', 'collecting', 'redeemed'] as const;

function vaultRedemptionSweepLockKey(): bigint {
  const digest = createHash('sha256').update('loop:vault-redemption-sweep').digest();
  const raw =
    (BigInt(digest[0]!) << 56n) |
    (BigInt(digest[1]!) << 48n) |
    (BigInt(digest[2]!) << 40n) |
    (BigInt(digest[3]!) << 32n) |
    (BigInt(digest[4]!) << 24n) |
    (BigInt(digest[5]!) << 16n) |
    (BigInt(digest[6]!) << 8n) |
    BigInt(digest[7]!);
  return BigInt.asIntN(64, raw);
}

export interface VaultRedemptionSweepResult {
  skippedLocked: boolean;
  considered: number;
  settled: number;
  advanced: number;
  failed: number;
  noVault: number;
  claimedElsewhere: number;
  errors: number;
  replenished: number;
}

export async function runVaultRedemptionSweepTick(args?: {
  batchSize?: number;
}): Promise<VaultRedemptionSweepResult> {
  const locked = await withAdvisoryLock(vaultRedemptionSweepLockKey(), () =>
    runVaultRedemptionSweepLocked(args),
  );
  if (!locked.ran) {
    return {
      skippedLocked: true,
      considered: 0,
      settled: 0,
      advanced: 0,
      failed: 0,
      noVault: 0,
      claimedElsewhere: 0,
      errors: 0,
      replenished: 0,
    };
  }
  return locked.value;
}

async function runVaultRedemptionSweepLocked(args?: {
  batchSize?: number;
}): Promise<VaultRedemptionSweepResult> {
  const result: VaultRedemptionSweepResult = {
    skippedLocked: false,
    considered: 0,
    settled: 0,
    advanced: 0,
    failed: 0,
    noVault: 0,
    claimedElsewhere: 0,
    errors: 0,
    replenished: 0,
  };
  if (!vaultsEnabled()) return result;

  const batchSize = args?.batchSize ?? 50;
  const rows = await db
    .select()
    .from(vaultRedemptions)
    .where(inArray(vaultRedemptions.state, [...SWEEP_STATES]))
    .orderBy(vaultRedemptions.createdAt)
    .limit(batchSize)
    .for('update', { skipLocked: true });
  result.considered = rows.length;

  // Sequential, deliberately — see the module header's cross-worker
  // sequence-number note.
  for (const row of rows) {
    try {
      const outcome = await driveOneVaultRedemption(row);
      switch (outcome) {
        case 'settled':
          result.settled++;
          break;
        case 'failed':
          result.failed++;
          break;
        case 'no_vault':
          result.noVault++;
          break;
        case 'claimed_elsewhere':
          result.claimedElsewhere++;
          break;
        case 'collecting':
        case 'redeemed':
          result.advanced++;
          break;
      }
    } catch (err) {
      result.errors++;
      log.error(
        { err, vaultRedemptionId: row.id, sourceId: row.sourceId },
        'vault redemption sweep: drive threw unexpectedly (should not happen — driveOneVaultRedemption catches internally)',
      );
    }
  }

  // Best-effort float replenishment, once per active vault per tick —
  // never blocks/fails the redemption sweep itself (module header:
  // relies on THIS sweep's fleet-wide lock for serialization).
  for (const assetCode of ['LOOPUSD', 'LOOPEUR'] as const) {
    try {
      const vault = await getActiveVault(assetCode, currentVaultNetwork());
      if (vault === null) continue;
      const r = await runHotFloatReplenishTick(vault);
      if (r.replenished) result.replenished++;
    } catch (err) {
      log.warn(
        { err, assetCode },
        'vault redemption sweep: hot-float replenish tick failed (non-fatal)',
      );
    }
  }

  return result;
}

// ─── Stuck-redemption watchdog (mirrors vault-emissions.ts's) ─────────────

const VAULT_REDEMPTION_STUCK_STATES = ['collecting', 'redeemed'] as const;
const VAULT_REDEMPTION_STUCK_ALERT_NAME = 'vault-redemption-stuck-watchdog';
export const VAULT_REDEMPTION_STUCK_WATCHDOG_INTERVAL_MS = 60 * 1000;

function vaultRedemptionStuckWatchdogLockKey(): bigint {
  const digest = createHash('sha256').update('loop:vault-redemption-stuck-watchdog').digest();
  const raw =
    (BigInt(digest[0]!) << 56n) |
    (BigInt(digest[1]!) << 48n) |
    (BigInt(digest[2]!) << 40n) |
    (BigInt(digest[3]!) << 32n) |
    (BigInt(digest[4]!) << 24n) |
    (BigInt(digest[5]!) << 16n) |
    (BigInt(digest[6]!) << 8n) |
    BigInt(digest[7]!);
  return BigInt.asIntN(64, raw);
}

export interface VaultRedemptionStuckWatchdogResult {
  skippedLocked: boolean;
  notified: boolean;
}

export async function runVaultRedemptionStuckWatchdog(args?: {
  thresholdMinutes?: number;
  limit?: number;
}): Promise<VaultRedemptionStuckWatchdogResult> {
  const thresholdMinutes = args?.thresholdMinutes ?? 15;
  const limit = args?.limit ?? 20;
  if (!vaultsEnabled()) return { skippedLocked: false, notified: false };
  return await db.transaction(async (tx) => {
    const lockResult = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(${vaultRedemptionStuckWatchdogLockKey()}) AS locked`,
    );
    const lockRows = Array.isArray(lockResult)
      ? (lockResult as Array<{ locked: boolean }>)
      : ((lockResult as { rows?: Array<{ locked: boolean }> }).rows ?? []);
    if (lockRows[0]?.locked !== true) {
      return { skippedLocked: true, notified: false };
    }

    const [alertRow] = await tx
      .select({ alertActive: watchdogAlertState.alertActive })
      .from(watchdogAlertState)
      .where(eq(watchdogAlertState.watchdogName, VAULT_REDEMPTION_STUCK_ALERT_NAME));
    const alertActive = alertRow?.alertActive ?? false;

    const rows = await tx
      .select({
        id: vaultRedemptions.id,
        state: vaultRedemptions.state,
        assetCode: vaultRedemptions.assetCode,
        createdAt: vaultRedemptions.createdAt,
      })
      .from(vaultRedemptions)
      .where(
        and(
          inArray(vaultRedemptions.state, [...VAULT_REDEMPTION_STUCK_STATES]),
          sql`${vaultRedemptions.createdAt} < NOW() - make_interval(mins => ${thresholdMinutes})`,
        ),
      )
      .orderBy(vaultRedemptions.createdAt)
      .limit(limit);

    if (rows.length === 0) {
      if (alertActive) {
        await tx
          .insert(watchdogAlertState)
          .values({ watchdogName: VAULT_REDEMPTION_STUCK_ALERT_NAME, alertActive: false })
          .onConflictDoUpdate({
            target: watchdogAlertState.watchdogName,
            set: { alertActive: false, updatedAt: sql`NOW()` },
          });
      }
      return { skippedLocked: false, notified: false };
    }
    if (alertActive) return { skippedLocked: false, notified: false };

    const oldest = rows.reduce((max, row) => {
      const ageMin = Math.round((Date.now() - row.createdAt.getTime()) / 60_000);
      return ageMin > max ? ageMin : max;
    }, 0);
    const uniqueStates = [...new Set(rows.map((r) => r.state))].sort().join(', ');
    const first = rows[0] ?? null;

    const delivered = await notifyVaultRedemptionsStuck({
      rowCount: rows.length,
      thresholdMinutes,
      oldestAgeMinutes: oldest,
      states: uniqueStates,
      vaultRedemptionId: first?.id ?? null,
      assetCode: first?.assetCode ?? null,
    });
    if (!delivered) return { skippedLocked: false, notified: false };
    await tx
      .insert(watchdogAlertState)
      .values({ watchdogName: VAULT_REDEMPTION_STUCK_ALERT_NAME, alertActive: true })
      .onConflictDoUpdate({
        target: watchdogAlertState.watchdogName,
        set: { alertActive: true, updatedAt: sql`NOW()` },
      });
    return { skippedLocked: false, notified: true };
  });
}

async function tickVaultRedemptionStuckWatchdog(): Promise<void> {
  try {
    await runVaultRedemptionStuckWatchdog();
  } catch (err) {
    log.error({ err }, 'Vault-redemption stuck watchdog tick failed');
  }
}

export const VAULT_REDEMPTION_SWEEP_TICK_INTERVAL_MS = 30_000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let stuckWatchdogTimer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

export async function tickVaultRedemptionSweep(): Promise<void> {
  if (tickInFlight) {
    log.warn('Vault-redemption sweep tick skipped — prior tick still running');
    return;
  }
  tickInFlight = true;
  try {
    const r = await runVaultRedemptionSweepTick();
    if (!r.skippedLocked && r.considered > 0) {
      log.info(
        {
          considered: r.considered,
          settled: r.settled,
          advanced: r.advanced,
          failed: r.failed,
          noVault: r.noVault,
          claimedElsewhere: r.claimedElsewhere,
          errors: r.errors,
          replenished: r.replenished,
        },
        'Vault-redemption sweep tick complete',
      );
    }
    if (r.failed > 0 || r.errors > 0) {
      markWorkerTickFailure(
        'vault_redemption_sweep',
        new Error(
          `vault-redemption sweep: ${r.failed} row(s) went terminal-failed, ${r.errors} unexpected drive error(s) this tick`,
        ),
      );
    } else {
      markWorkerTickSuccess('vault_redemption_sweep');
    }
  } catch (err) {
    markWorkerTickFailure('vault_redemption_sweep', err);
    log.error({ err }, 'Vault-redemption sweep tick failed');
  } finally {
    tickInFlight = false;
  }
}

export function startVaultRedemptionSweep(args?: {
  intervalMs?: number;
  stuckWatchdogIntervalMs?: number;
}): void {
  stopVaultRedemptionSweep();
  const intervalMs = args?.intervalMs ?? VAULT_REDEMPTION_SWEEP_TICK_INTERVAL_MS;
  markWorkerStarted('vault_redemption_sweep', { staleAfterMs: Math.max(intervalMs * 3, 60_000) });
  log.info({ intervalMs }, 'Starting vault-redemption sweep worker (ADR 031 V4)');
  setImmediate(() => {
    void tickVaultRedemptionSweep();
  });
  sweepTimer = setInterval(() => {
    void tickVaultRedemptionSweep();
  }, intervalMs);
  sweepTimer.unref();

  const watchdogIntervalMs =
    args?.stuckWatchdogIntervalMs ?? VAULT_REDEMPTION_STUCK_WATCHDOG_INTERVAL_MS;
  stuckWatchdogTimer = setInterval(() => {
    void tickVaultRedemptionStuckWatchdog();
  }, watchdogIntervalMs);
  stuckWatchdogTimer.unref();
}

export function stopVaultRedemptionSweep(): void {
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  if (stuckWatchdogTimer !== null) {
    clearInterval(stuckWatchdogTimer);
    stuckWatchdogTimer = null;
  }
  markWorkerStopped('vault_redemption_sweep');
}
