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
 *      collecting)  a fresh share-price read, CAPPED at the user's
 *                    on-chain share holding (MNY-06 — no user-side
 *                    buffer; a full-balance redemption collects the
 *                    user's ENTIRE holding and never more), BEFORE any
 *                    transfer is built — persisted once, reused on every
 *                    resume (never recomputed — see the schema doc
 *                    comment for why this differs from
 *                    `vault_emissions.min_shares_used`).
 *                    `collectSharesStep` then does the ONE user-wallet
 *                    signature in the whole vault system:
 *                    `transferShares({ signWith: 'provider' })`
 *                    (user's wallet -> operator). `payoutStep` then
 *                    pays out `value_minor` — FAST (hot float) or SLOW
 *                    (a synchronous `vault.withdraw`) — landing the row
 *                    on `redeemed`.
 *   3. redeemed     shares collected AND `value_minor` paid out (the
 *                    user always receives EXACTLY `value_minor`).
 *                    `payout_path` + (for slow) `redeem_tx_hash`
 *                    persisted. INV-V2 (redemption solvency, MNY-06):
 *                    the slow-path withdraw's `minAmountsOut` is a
 *                    CATASTROPHIC-slippage floor (`value_minor` less the
 *                    `REDEMPTION_SLIPPAGE_TOLERANCE_BPS` band), not an
 *                    exact `value_minor` floor — within the band the
 *                    operator float absorbs `amountOut − value_minor` in
 *                    EITHER direction; a shortfall beyond it reverts
 *                    (`VaultPostSubmitSlippageError`) rather than draining
 *                    the float on a real de-peg.
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
 * ── Concurrency: two drivers, three guards ──────────────────────────
 * `driveOneVaultRedemption` is deliberately callable from BOTH
 * `orders/redeem.ts`'s inline drive AND this module's sweep, so every
 * money-moving step is individually claim/CAS-guarded — the sweep's
 * fleet-wide advisory lock is a throughput layer, NOT the correctness
 * guarantee (unlike V3, whose sole driver is the single-flighted sweep):
 *   - COLLECT (money-review P1-B): the `pending -> collecting` CAS only
 *     guards the state TRANSITION, not OPERATING on a `collecting` row.
 *     A separate per-step lease claim (`collectClaimedAt`, CAS-committed
 *     BEFORE the user-signed transfer's network call) serializes the
 *     collect itself — exactly one driver submits `transfer(user ->
 *     operator)`; the loser no-ops. On resume, the transfer is
 *     RE-INVOKED with `priorTxHash: collectTxHash` so its CF-18
 *     `checkPriorSorobanTx` VERIFIES the prior tx landed (or re-submits)
 *     before `collectedAt` is set — a persisted `collect_tx_hash` is
 *     NOT proof of landing (money-review P1-A: `onSigned` persists it
 *     BEFORE submit, which can throw).
 *   - PAYOUT: `payoutStep`'s guarded `WHERE state='collecting'` UPDATE,
 *     rolled back together with its float write via
 *     `PayoutAlreadyLandedError` when the guard misses, makes a LANDED
 *     payout safe against double-crediting/double-drawing the float.
 *   - MIRROR: coupled STRICTLY to order payability — the order is
 *     re-read `FOR UPDATE` and required `pending_payment` BEFORE the
 *     debit (money-review P2-3, like classic `markOrderPaid`); the
 *     `credit_transactions_reference_unique` fence dedups a re-drive.
 *
 * ── Known residual (NOT self-correcting — needs drift reconcile) ─────
 * PAYOUT slow path: if two drivers both read the row at
 * `redeemTxHash === null` and BOTH fail the fast-path draw (float
 * insufficient for both), both can build a REAL on-chain
 * `withdrawFromVault` for the SAME `sharesToRedeem` before either
 * commits. The vault contract can't burn more shares than the operator
 * holds, so the loser's on-chain call typically fails — BUT if a rare
 * interleaving lets both land (e.g. the operator holds enough shares
 * from other rows), the result is an OVER-withdraw: shares burned and
 * proceeds received with only one `vault_redemptions` row crediting the
 * float, leaving UNTRACKED float/pool drift (NOT self-correcting) that
 * the vault-aware R3-1 operator-float reconciliation must catch and
 * reconcile. That reconciliation being vault-aware is a prerequisite
 * before `LOOP_VAULTS_ENABLED` is flipped on (a V5 item). Fully closing
 * the race needs a per-row advisory lock around the WHOLE payout step
 * (beyond the CAS) — deferred as a V5 tightening; flagged for
 * money-review.
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
  orders,
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
  getShareBalance,
  resolveOperatorPublicKey,
} from './vault-client.js';
import { generatePayoutMemo } from '../payout-builder.js';
import { markOrderPaidViaVaultRedemption } from '../../orders/transitions.js';
import { recordVaultOperatorMovement } from '../../treasury/vault-operator-movement.js';
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

/**
 * MNY-06: slippage tolerance on the SLOW-path withdraw's `minAmountsOut`
 * floor — INV-V2's CATASTROPHIC-slippage backstop. There is no longer a
 * user-side share buffer (removed in MNY-06 so a full-balance redemption
 * can always cash out 100%; see `computeSharesToRedeem`), so a
 * buffer-free `sharesToRedeem` withdraws to ~`value_minor` give or take
 * integer truncation and a small share-price tick between the quote and
 * the withdraw. An EXACT `value_minor` floor would therefore fail-closed
 * on ordinary rounding. This 0.5% band — the SAME tolerance the deposit
 * (`DEPOSIT_SLIPPAGE_TOLERANCE_BPS`) and float-replenish
 * (`REPLENISH_SLIPPAGE_TOLERANCE_BPS`) withdraws already use — lets the
 * operator float absorb ordinary slippage in EITHER direction, while a
 * real de-peg / oracle failure (a shortfall beyond 0.5%) still throws
 * `VaultPostSubmitSlippageError` and reverts: an ops incident, never a
 * silent float drain. NOT weakened to a no-op — it stays a real floor.
 */
const REDEMPTION_SLIPPAGE_TOLERANCE_BPS = 50n; // 0.5%

/**
 * Money-review P1-B: the COLLECT claim lease. A `collect_claimed_at`
 * older than this is treated as abandoned (a crashed collector) and
 * the collect is re-acquirable. MUST exceed the collect transfer's
 * worst-case wall-clock so a still-running collector's claim is never
 * stolen mid-flight (which would let a second driver re-submit against
 * the in-flight tx). The transfer's inner tx carries a 60s timebound
 * (`prepareSorobanInvocationForExternalSigning` default) so any signed
 * tx is permanently dead after ~60s; 3 min comfortably covers the
 * getAccount + simulate + provider-sign + Horizon-submit chain plus
 * margin, and stays under the 15-min stuck-watchdog.
 */
const COLLECT_CLAIM_LEASE_MS = 3 * 60 * 1000;

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

/**
 * The share count to collect from the user's wallet for `valueMinor` —
 * a live `readVaultState` price, CAPPED at the user's actual on-chain
 * share holding (MNY-06). Never returns more than the user holds, and
 * never 0.
 *
 * ── MNY-06: no user-side buffer, cap at the holding ─────────────────
 * `baseShares` is what `valueMinor` is worth at the fresh share price.
 * The old code collected `baseShares + 0.5%`, which BROKE two ways:
 *   1. A user redeeming their FULL balance holds ONLY `baseShares` (a
 *      no-yield position is worth exactly `baseShares × price`), so
 *      `transfer(user → operator, baseShares + 0.5%)` asks for more
 *      shares than the user holds and FAILS CLOSED on-chain — 100%
 *      cash-out was impossible.
 *   2. On a partial, that extra 0.5% of backing drifted from the user
 *      into the operator float on every redemption.
 * The user is paid EXACTLY `value_minor` regardless (see `payoutStep`;
 * the float absorbs `amountOut − value_minor` in EITHER direction, ADR
 * 031 §D6 / INV-V2), so the buffer only ever over-collected SHARES.
 *
 * The fix: collect `min(baseShares, held)`.
 *   - Partial (`baseShares < held`): collect exactly `baseShares` — the
 *     precise backing for `value_minor`, no drift.
 *   - Full balance (`baseShares ≥ held`, because the position is worth
 *     `value_minor`): collect the user's ENTIRE remaining holding,
 *     draining the position to zero value with no stranded share dust,
 *     and — critically — always succeeding, since we never ask for more
 *     shares than the user actually holds. (Yield is non-rebasing and
 *     accrues to the USER as share appreciation, ADR 031 §Share-price
 *     model: a user who has NOT redeemed their full value still holds
 *     `held > baseShares` and correctly keeps the surplus yield shares.)
 */
async function computeSharesToRedeem(
  vault: LoopVaultRow,
  valueMinor: bigint,
  fromAddress: string,
): Promise<bigint> {
  const state = await readVaultState({ vault });
  const underlyingStroops = valueMinor * STROOPS_PER_MINOR;
  const baseShares = (underlyingStroops * 1_000_000n) / state.sharePricePpm;
  // Cap at the user's REAL holding — never over-collect (a transfer for
  // more shares than the user holds fails closed on-chain).
  const held = await getShareBalance({ vault, address: fromAddress });
  const sharesToRedeem = baseShares < held ? baseShares : held;
  if (sharesToRedeem <= 0n) {
    throw new Error(
      `computeSharesToRedeem: computed non-positive sharesToRedeem (${sharesToRedeem}) for valueMinor=${valueMinor}, sharePricePpm=${state.sharePricePpm}, held=${held}`,
    );
  }
  return sharesToRedeem;
}

/**
 * Money-review P1-B: the per-step COLLECT claim. An atomic state-CAS on
 * `collect_claimed_at` committed BEFORE any network call — mirrors V3's
 * `claimEmissionForDeposit` (`pending -> depositing`), but adapted to
 * the fact that V4 has TWO concurrent drivers (the HTTP inline drive +
 * the sweep), so the `pending -> collecting` transition-CAS alone does
 * NOT serialize operating on a `collecting` row. Only one driver wins
 * this guarded UPDATE at a time; the loser gets `null` and no-ops.
 *
 * Re-acquirable once the claim is older than `COLLECT_CLAIM_LEASE_MS`
 * (a crashed collector) — and only while `collected_at IS NULL` (once
 * the collect has confirmed-landed there is nothing left to claim).
 */
async function claimCollect(id: string): Promise<VaultRedemptionRow | null> {
  const leaseSeconds = Math.floor(COLLECT_CLAIM_LEASE_MS / 1000);
  const [row] = await db
    .update(vaultRedemptions)
    .set({ collectClaimedAt: new Date() })
    .where(
      and(
        eq(vaultRedemptions.id, id),
        eq(vaultRedemptions.state, 'collecting'),
        sql`${vaultRedemptions.collectedAt} IS NULL`,
        sql`(${vaultRedemptions.collectClaimedAt} IS NULL OR ${vaultRedemptions.collectClaimedAt} < NOW() - make_interval(secs => ${leaseSeconds}))`,
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * ADR 031 §D1 — the ONE user-wallet signature (`transfer(user ->
 * operator)`), plus the money-review P1-A/P1-B/P2-5 fixes:
 *
 *   - P1-B: claims the collect exclusively (`claimCollect`) before any
 *     network call, so exactly one driver submits the transfer.
 *   - P1-A: a persisted `collect_tx_hash` is NOT proof the transfer
 *     landed (`transferSharesViaProvider` persists it via `onSigned`
 *     BEFORE `attachUserWalletSignature` + submit, either of which can
 *     throw). So the transfer is always (re-)invoked with `priorTxHash:
 *     collectTxHash` — its CF-18 `checkPriorSorobanTx` VERIFIES the
 *     prior tx landed (dedupes) or re-submits — and `collected_at` is
 *     set ONLY after the call returns success (= landed). A crash after
 *     `onSigned` but before landing therefore resumes as a VERIFY, not
 *     a blind advance (the exact bug V3's `transferStep` avoids the
 *     same way).
 *   - P2-5: rechecks `walletProvisioning === 'activated'`, not just
 *     wallet presence — parity with the entry guard in `redeem-vault.ts`.
 *
 * `sharesToRedeem` is computed ONCE, inside the claim (so two drivers
 * can't compute divergent counts), and pinned thereafter — required for
 * the CF-18 hash-dedup to ever match across retries.
 */
async function collectSharesStep(
  row: VaultRedemptionRow,
  vault: LoopVaultRow,
): Promise<VaultRedemptionRow> {
  // Already collected + confirmed-landed — nothing to do.
  if (row.collectedAt !== null) return row;

  // P1-B: exclusive claim before any network call. Loser no-ops
  // (returns the row unchanged → the caller sees no forward progress).
  const claimed = await claimCollect(row.id);
  if (claimed === null) return row;
  let current = claimed;
  const id = current.id;

  try {
    // P2-5: require an ACTIVATED wallet (not just present).
    const user = await getUserById(current.userId);
    if (
      user === null ||
      user.walletProvisioning !== 'activated' ||
      user.walletId === null ||
      user.walletAddress === null
    ) {
      throw new Error(
        `vault redemption ${id}: user ${current.userId} has no activated embedded wallet`,
      );
    }
    const provider = getWalletProvider();
    if (provider === null) {
      throw new Error(
        'vault redemption collect step: wallet provider is not configured (LOOP_WALLET_PROVIDER unset)',
      );
    }

    // Compute the share count ONCE (inside the claim), pin it.
    if (current.sharesToRedeem === null) {
      const shares = await computeSharesToRedeem(vault, current.valueMinor, current.fromAddress);
      const [withShares] = await db
        .update(vaultRedemptions)
        .set({ sharesToRedeem: shares })
        .where(eq(vaultRedemptions.id, id))
        .returning();
      if (withShares === undefined) {
        throw new Error(`vault_redemptions update returned no row (id=${id}, compute-shares)`);
      }
      current = withShares;
    }
    if (current.sharesToRedeem === null) {
      throw new Error(`invariant: vault redemption ${id} has no sharesToRedeem at collect step`);
    }

    // P1-A: verify-or-submit. `priorTxHash` makes the transfer confirm
    // the prior attempt landed (or re-submit) rather than blindly
    // advancing on a hash that may never have landed.
    const walletId = user.walletId;
    const result = await transferShares({
      vault,
      from: current.fromAddress,
      to: resolveOperatorPublicKey(),
      amount: current.sharesToRedeem,
      signWith: 'provider',
      userWallet: { provider, walletId },
      ...(current.collectTxHash !== null ? { priorTxHash: current.collectTxHash } : {}),
      onSigned: async (txHash) => {
        // CF-18: persist BEFORE the user-sign + submit round trip.
        await db
          .update(vaultRedemptions)
          .set({ collectTxHash: txHash })
          .where(eq(vaultRedemptions.id, id));
      },
    });
    // Success here means the transfer LANDED (Horizon `submitTransaction`
    // returns on inclusion; the deduped path confirmed a prior SUCCESS).
    const [updated] = await db
      .update(vaultRedemptions)
      .set({ collectTxHash: result.txHash, collectedAt: new Date() })
      .where(eq(vaultRedemptions.id, id))
      .returning();
    if (updated === undefined) {
      throw new Error(`vault_redemptions update returned no row (id=${id}, collect step)`);
    }
    return updated;
  } catch (err) {
    return recordStepFailure(current, err);
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
    // CATASTROPHIC-slippage floor: `withdrawFromVault` throws
    // `VaultPostSubmitSlippageError` rather than let this row settle when
    // the withdraw returns LESS than `value_minor` worth by more than the
    // `REDEMPTION_SLIPPAGE_TOLERANCE_BPS` band. MNY-06: this band is
    // deliberately > 0 (was an exact `value_minor` floor) — with the
    // user-side share buffer removed, `sharesToRedeem` withdraws to
    // ~`value_minor` ± integer truncation ± a small tick, so an exact
    // floor would fail-closed on ordinary rounding. Within the band the
    // operator float ABSORBS `amountOut − value_minor` in either
    // direction (the user is still paid exactly `value_minor`); beyond it,
    // a real de-peg / oracle failure still reverts (ops incident, not a
    // silent drain). The band is NOT weakened to a no-op.
    const expectedOutStroops = row.valueMinor * STROOPS_PER_MINOR;
    const minAmountsOut =
      expectedOutStroops - (expectedOutStroops * REDEMPTION_SLIPPAGE_TOLERANCE_BPS) / 10_000n;
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
    // MNY-06: this can now be slightly NEGATIVE on an adverse tick (before,
    // the removed user-side buffer biased proceeds ~0.5% high, keeping it
    // positive). `applyHotFloatDeltaInTx` applies it as a SIGNED balance
    // delta, so a negative value simply DRAWS the operator float down —
    // the owner-accepted "float subsidises adverse slippage, funded by
    // yield/revenue" posture. Bounded below by `minAmountsOut`
    // (REDEMPTION_SLIPPAGE_TOLERANCE_BPS) and by the float's own
    // `vault_hot_float_balance_non_negative` CHECK (the float can never go
    // negative — a slow redemption against a near-empty float and an
    // adverse tick fails closed and retries/pages, an ops incident).
    const netFloatDelta = amountOutMinor - row.valueMinor;
    // MNY-06-REDEMPTION-DUST: `amountOutMinor` TRUNCATES the sub-minor
    // remainder of the REAL on-chain proceeds — `amountOutStroops %
    // STROOPS_PER_MINOR` stroops of favorable-slippage USDC that would
    // otherwise be silently DROPPED from the float on every slow-path
    // redemption (the same leak MNY-06-hotfloat fixed on the replenish
    // path, on the SAME `vault_hot_float`). Carry that remainder forward
    // in `carry_stroops` so the float conserves the FULL proceeds:
    // `balance_minor * PER + carry_stroops == Σ amountOutStroops − Σ
    // valueMinor*PER`. The remainder is non-negative, so it never drives
    // the DB-CHECKed carry below zero even when `netFloatDelta` (the
    // signed whole-minor part, favorable or unfavorable slippage) is
    // negative.
    const proceedsCarryStroops = amountOutStroops % STROOPS_PER_MINOR;

    let slowPathLanded = false;
    let slowPathResult: VaultRedemptionRow;
    try {
      slowPathResult = await db.transaction(async (tx) => {
        await applyHotFloatDeltaInTx(
          tx,
          assetCode,
          network,
          netFloatDelta,
          0n,
          proceedsCarryStroops,
        );
        const [updated] = await tx
          .update(vaultRedemptions)
          .set({ state: 'redeemed', payoutPath: 'slow', redeemedAt: new Date() })
          .where(and(eq(vaultRedemptions.id, row.id), eq(vaultRedemptions.state, 'collecting')))
          .returning();
        if (updated === undefined) throw new PayoutAlreadyLandedError();
        return updated;
      });
      slowPathLanded = true;
    } catch (err) {
      if (!(err instanceof PayoutAlreadyLandedError)) throw err;
      // Another driver already landed the transition — the float
      // credit above rolled back with the rest of this transaction
      // (the thrown sentinel forces Postgres to roll back, so nothing
      // was double-counted). The on-chain withdraw itself already
      // landed regardless (its proceeds are safe — a future retry of
      // THIS row would dedupe via `redeemTxHash`'s CF-18 fence, but
      // this row won't be retried again since it's already past
      // 'collecting'); re-read the current state and return it. Do
      // NOT record an R3-1 movement note here — the WINNING driver's
      // own successful-transition branch already recorded it (or will
      // never re-enter this function for this row again).
      const [fresh] = await db
        .select()
        .from(vaultRedemptions)
        .where(eq(vaultRedemptions.id, row.id));
      if (fresh === undefined) {
        throw new Error(`vault_redemptions row ${row.id} vanished mid-payout step`);
      }
      return fresh;
    }
    if (slowPathLanded) {
      // V5 (ADR 031 §D4): explain this USDC-denominated inflow to
      // R3-1 (`treasury/hot-float-reconciliation.ts`) — best-effort,
      // placed after the state transition commits, same "record once,
      // possibly miss rather than double-count" reasoning as
      // `vault-emissions.ts`'s depositStep.
      await recordVaultOperatorMovement({
        vault,
        direction: 'in',
        amountStroops: amountOutStroops,
        reason: `Vault redemption slow-path withdraw for ${row.sourceType} ${row.sourceId} (vault_redemptions ${row.id})`,
      });
    }
    return slowPathResult;
  } catch (err) {
    return recordStepFailure(row, err);
  }
}

/**
 * Money-review P2-3: thrown INSIDE the mirror transaction when the
 * source order is no longer payable (e.g. `sweepExpiredOrders` flipped
 * it to `expired`) AND this redemption never debited the mirror. Forces
 * a rollback (no debit) — caught in `mirrorStep`, which routes the row
 * to a terminal refund-needed state instead of debiting the user for an
 * order that delivers no card.
 */
class VaultRedemptionOrderNotPayableError extends Error {
  constructor(
    readonly orderId: string,
    readonly orderState: string,
  ) {
    super(`order ${orderId} is ${orderState}, no longer payable`);
    this.name = 'VaultRedemptionOrderNotPayableError';
  }
}

/**
 * Money-review P2-3: the terminal disposition when a redemption's
 * source order became non-payable before the mirror debit. Fails CLOSED
 * — mirror NOT debited (rolled back), row `-> failed` with a precise
 * error, and pages ops (the collected shares are with the operator and
 * need a manual refund; the auto-refund flow is a documented V5
 * follow-up, consistent with V4's "ops reconciles failed rows"
 * posture). Bypasses the attempts counter (retrying can't make an
 * expired order payable).
 */
async function markRedemptionNeedsRefund(
  row: VaultRedemptionRow,
  reason: string,
): Promise<VaultRedemptionRow> {
  const lastError =
    `order not payable at mirror time (${reason}) — mirror NOT debited; collected shares require a manual refund`.slice(
      0,
      1000,
    );
  const [updated] = await db
    .update(vaultRedemptions)
    .set({ state: 'failed', failedAt: new Date(), lastError })
    .where(eq(vaultRedemptions.id, row.id))
    .returning();
  if (updated === undefined) {
    throw new Error(`vault_redemptions update returned no row (id=${row.id}, needs-refund)`);
  }
  log.error(
    { vaultRedemptionId: row.id, sourceId: row.sourceId, reason },
    'vault redemption: source order not payable at mirror time — mirror not debited; collected shares need a manual refund',
  );
  notifyVaultRedemptionFailed({
    vaultRedemptionId: updated.id,
    sourceType: updated.sourceType,
    sourceId: updated.sourceId,
    userId: updated.userId,
    assetCode: updated.assetCode,
    valueMinor: updated.valueMinor.toString(),
    attempts: updated.attempts,
    lastError,
  });
  return updated;
}

/**
 * ADR 036 — extinguish both halves. Debits `user_credits` by
 * `value_minor` and writes a `pending_payouts kind='burn'` audit row
 * — the EXISTING primitive `orders/transitions.ts` writes for classic
 * redemptions, reused verbatim (no new payout kind). For
 * `source_type='order_redeem'`, transitions the source order
 * `pending_payment -> paid` in the SAME transaction.
 *
 * Money-review hardening: the debit is coupled STRICTLY to order
 * payability (P2-3 — the order is re-read `FOR UPDATE` and required
 * `pending_payment` BEFORE any debit, exactly like classic
 * `markOrderPaid`'s `if (paid === undefined) return null`) and to the
 * mirror row's existence (P2-4 — a missing `user_credits` row throws +
 * rolls back rather than inserting a `credit_transactions` debit with
 * no balancing balance mutation).
 */
async function mirrorStep(
  row: VaultRedemptionRow,
  vault: LoopVaultRow,
): Promise<VaultRedemptionRow> {
  // NS-08 (design §5B #7): this vault mirror debit runs AFTER
  // `collectSharesStep` has already transferred the user's vault shares
  // to the operator (the money already left the wallet on-chain). The
  // freeze is enforced at the vault REDEMPTION ENTRY GATE
  // (redeem-vault.ts §5A #3), which refuses to claim/collect for a frozen
  // account. By the time we reach here the shares are collected, so this
  // debit merely RECONCILES the off-chain mirror — and per design §6 Q7
  // (let in-flight settlement complete) we deliberately do NOT block it:
  // blocking would leave the mirror un-debited while the shares are gone,
  // an INV-1 desync that CREDITS the frozen user. Documented, not
  // silently skipped.
  try {
    if (row.sharesToRedeem === null || row.collectTxHash === null || row.payoutPath === null) {
      throw new Error(
        `invariant: vault redemption ${row.id} is 'redeemed' with missing sharesToRedeem/collectTxHash/payoutPath`,
      );
    }
    const currency = vault.assetCode === 'LOOPUSD' ? 'USD' : 'EUR';

    let pendingPayoutId: string | null = null;
    // `true` when the txn committed a no-op because THIS redemption
    // already mirrored (idempotent re-drive) — advance to settled.
    let alreadyMirrored = false;
    try {
      await db.transaction(async (tx) => {
        // P2-3: couple the debit to order payability. Re-read the order
        // FOR UPDATE and require `pending_payment` BEFORE debiting —
        // exactly like classic `markOrderPaid`'s state guard.
        if (row.sourceType === 'order_redeem') {
          const [order] = await tx
            .select({ state: orders.state })
            .from(orders)
            .where(eq(orders.id, row.sourceId))
            .for('update');
          if (order === undefined) {
            throw new Error(
              `vault redemption ${row.id}: source order ${row.sourceId} not found at mirror step`,
            );
          }
          if (order.state !== 'pending_payment') {
            // Distinguish "already mirrored by THIS redemption" (a
            // legitimate idempotent re-drive — the order is now paid
            // BECAUSE we paid it) from "order became non-payable
            // (expired) before we ever debited".
            const already = await tx
              .select({ id: creditTransactions.id })
              .from(creditTransactions)
              .where(
                and(
                  eq(creditTransactions.type, 'spend'),
                  eq(creditTransactions.referenceType, 'order'),
                  eq(creditTransactions.referenceId, row.sourceId),
                ),
              )
              .limit(1);
            if (already.length > 0) {
              alreadyMirrored = true;
              return; // commit no-op; advance to settled outside.
            }
            // Never debited AND order not payable → REFUND path. Roll
            // back (no debit) and route to needs-refund outside.
            throw new VaultRedemptionOrderNotPayableError(row.sourceId, order.state);
          }
        }

        // Lock-then-write (INV-2). P2-4: the mirror row MUST exist — a
        // user redeeming vault shares acquired them via a cashback
        // emission that wrote this row. An absent row is state
        // corruption; throw + roll back rather than insert a
        // `credit_transactions` debit whose balancing UPDATE matches 0
        // rows (a silent INV-1 desync — the exact fail-open the classic
        // `markOrderPaid` closes with `LoopAssetMissingCreditRowError`).
        const [existing] = await tx
          .select({ balanceMinor: userCredits.balanceMinor })
          .from(userCredits)
          .where(and(eq(userCredits.userId, row.userId), eq(userCredits.currency, currency)))
          .for('update');
        if (existing === undefined) {
          throw new Error(
            `vault redemption ${row.id}: user ${row.userId} has no ${currency} user_credits row at mirror step — state corruption, refusing to debit`,
          );
        }

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
          // We hold the order FOR UPDATE and verified pending_payment
          // above, so this MUST transition — a null return is an
          // invariant violation (roll back, don't silently proceed).
          const paid = await markOrderPaidViaVaultRedemption(tx, row.sourceId);
          if (paid === null) {
            throw new Error(
              `vault redemption ${row.id}: markOrderPaidViaVaultRedemption returned null despite a held pending_payment lock on order ${row.sourceId}`,
            );
          }
        }
      });
    } catch (err) {
      if (err instanceof VaultRedemptionOrderNotPayableError) {
        // P2-3: fail closed to a manual-refund terminal state. No debit
        // happened (the txn rolled back).
        return await markRedemptionNeedsRefund(row, err.message);
      }
      if (isUniqueViolation(err, 'credit_transactions_reference_unique')) {
        // Idempotent backstop: a prior mirror attempt already committed
        // the debit (rare — the order-state branch above catches the
        // common re-drive first). Advance without double-crediting.
        log.warn(
          { vaultRedemptionId: row.id, sourceId: row.sourceId },
          'vault redemption mirror step: credit_transactions row already exists — treating as already-mirrored',
        );
        alreadyMirrored = true;
      } else {
        throw err;
      }
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
    if (alreadyMirrored) {
      log.info(
        { vaultRedemptionId: row.id, sourceId: row.sourceId },
        'vault redemption mirror step: already mirrored by this redemption — advanced to settled (idempotent)',
      );
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
    // collectSharesStep folds in compute + the P1-B claim + the P1-A
    // verify-or-submit; it advances `collected_at` only once the
    // transfer has CONFIRMED landed.
    current = await collectSharesStep(current, vault);
    // Gate payout on collected_at (landed), NOT collect_tx_hash — a
    // persisted hash is not proof of landing (money-review P1-A).
    if (current.state === 'collecting' && current.collectedAt !== null) {
      current = await payoutStep(current, vault);
    }
  }
  if (current.state === 'redeemed') {
    current = await mirrorStep(current, vault);
  }
  return current.state as VaultRedemptionDriveOutcome;
}

// ─── Admin re-drive support (V7 — the recovery complement to the V5a stuck-watchdog page) ──
//
// Mirrors `vault-emissions.ts`'s equivalent section. `driveOneVaultRedemption`
// above is unchanged and does NOT handle `state === 'failed'` at all (it
// falls through every branch and returns `'failed'` verbatim) — these
// primitives exist to move a `failed` row back into a resumable state
// (or detect it should NOT be moved at all) before the admin handler
// calls the unmodified drive function exactly once.

/** By id — the admin handler's only "does this row exist" read. */
export async function getVaultRedemptionById(id: string): Promise<VaultRedemptionRow | null> {
  const [row] = await db.select().from(vaultRedemptions).where(eq(vaultRedemptions.id, id));
  return row ?? null;
}

/**
 * The exact prefix `markRedemptionNeedsRefund` writes into `lastError`
 * — the durable, greppable signature of "mirrorStep hit
 * `VaultRedemptionOrderNotPayableError`: the payout already landed
 * (shares collected, value paid out) but the source order was no
 * longer payable, so the mirror debit was deliberately NOT applied and
 * the collected shares need a MANUAL refund." Exported so the admin
 * handler can distinguish this from an ordinary step failure without
 * re-deriving the string.
 */
export const VAULT_REDEMPTION_NEEDS_REFUND_ERROR_PREFIX = 'order not payable at mirror time';

/**
 * True for a `failed` row that reached its terminal state via
 * `markRedemptionNeedsRefund` rather than via the ordinary
 * `recordStepFailure` attempts-exhausted path. This is NOT a step that
 * re-driving can fix — the payout already happened; re-entering
 * `mirrorStep` would just hit the exact same
 * `VaultRedemptionOrderNotPayableError` again (the source order's
 * non-payable state doesn't change on retry) and re-page ops for
 * nothing. The admin handler refuses re-drive on this signature and
 * surfaces the needs-refund status instead of touching the row.
 */
export function isVaultRedemptionNeedsRefund(row: VaultRedemptionRow): boolean {
  return (
    row.state === 'failed' &&
    row.lastError !== null &&
    row.lastError.startsWith(VAULT_REDEMPTION_NEEDS_REFUND_ERROR_PREFIX)
  );
}

export type VaultRedemptionRedriveResumeState = 'collecting' | 'redeemed';

/**
 * Infers the correct resume state for a genuine (non-needs-refund)
 * `failed` row from `redeemedAt` — set ONLY in the same UPDATE that
 * lands the payout (`payoutStep`'s fast/slow branches), so it is proof
 * the payout itself landed, unlike `collectTxHash`/`payoutPath` which
 * can be set by an in-flight/aborted attempt (CF-18 `onSigned`
 * persists `collectTxHash` before the collect transfer is even
 * submitted):
 *
 *   - `redeemedAt` set → collect AND payout both landed; only the
 *     mirror is outstanding. Resume at `'redeemed'` (drive re-enters
 *     at `mirrorStep`; `collectSharesStep`/`payoutStep` are never
 *     called again for this row).
 *   - `redeemedAt` unset → payout has not landed (collect may or may
 *     not have — `collectedAt`, same reasoning, is the landed-proof
 *     for THAT sub-step). Resume at `'collecting'`:
 *     `driveOneVaultRedemption`'s existing branch handles both
 *     sub-cases correctly without any further help from this
 *     function — `collectSharesStep` no-ops immediately if
 *     `collectedAt !== null` ("nothing to do") and falls straight to
 *     `payoutStep`, or re-claims + verify-or-resubmits the collect
 *     transfer via `priorTxHash: row.collectTxHash` if it doesn't.
 */
export function inferVaultRedemptionResumeState(
  row: VaultRedemptionRow,
): VaultRedemptionRedriveResumeState {
  return row.redeemedAt !== null ? 'redeemed' : 'collecting';
}

export type VaultRedemptionReclaimResult =
  | { kind: 'not_found' }
  /** Row exists but was not `'failed'` at claim time (already redriven by a concurrent call, or moved on its own). */
  | { kind: 'not_failed'; row: VaultRedemptionRow }
  /** `failed` via `markRedemptionNeedsRefund` — NOT reclaimed; the caller must surface the needs-refund status, not re-drive. */
  | { kind: 'needs_refund'; row: VaultRedemptionRow }
  | { kind: 'reclaimed'; row: VaultRedemptionRow };

/**
 * Atomically reclaims a `failed` vault-redemption row for re-drive —
 * mirrors `reclaimFailedVaultEmissionForRedrive` exactly, plus the
 * needs-refund short-circuit. Locks the row (`FOR UPDATE`), verifies
 * `'failed'`, refuses (without mutating) a needs-refund row, else
 * computes the resume target from the SAME locked row and CAS-updates
 * `state → resumeState, attempts → 0, lastError → null, failedAt →
 * null`. Resuming into `'collecting'` also clears `collectClaimedAt`
 * so the per-step collect lease (`claimCollect`'s
 * `COLLECT_CLAIM_LEASE_MS`) is immediately re-acquirable rather than
 * depending on the old claim timing out.
 *
 * Does NOT drive the row — the caller (the admin handler) does that
 * via the ordinary `driveOneVaultRedemption(row)`, exactly once, using
 * the row this function returns. Safe to do so inline/synchronously,
 * unlike the emission-side equivalent — `driveOneVaultRedemption` is
 * explicitly designed for concurrent callers (see the module header's
 * "Concurrency: two drivers, three guards"), so a redrive call racing
 * the background sweep on the SAME row is the exact scenario the
 * per-step `collectClaimedAt` CAS + `payoutStep`'s guarded UPDATE
 * already make safe.
 */
export async function reclaimFailedVaultRedemptionForRedrive(
  id: string,
): Promise<VaultRedemptionReclaimResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(vaultRedemptions)
      .where(eq(vaultRedemptions.id, id))
      .for('update');
    if (row === undefined) return { kind: 'not_found' };
    if (row.state !== 'failed') return { kind: 'not_failed', row };
    if (isVaultRedemptionNeedsRefund(row)) return { kind: 'needs_refund', row };
    const resumeState = inferVaultRedemptionResumeState(row);
    const [updated] = await tx
      .update(vaultRedemptions)
      .set({
        state: resumeState,
        attempts: 0,
        lastError: null,
        failedAt: null,
        ...(resumeState === 'collecting' ? { collectClaimedAt: null } : {}),
      })
      .where(and(eq(vaultRedemptions.id, id), eq(vaultRedemptions.state, 'failed')))
      .returning();
    if (updated === undefined) return { kind: 'not_failed', row };
    return { kind: 'reclaimed', row: updated };
  });
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
    // Money-review P1-B: `claimed_elsewhere` (lost the `pending ->
    // collecting` CAS) must STOP the inline loop, not re-enter — another
    // driver owns this row. Re-looping would re-drive a `collecting` row
    // concurrently with its owner (the exact double-collect vector the
    // per-step claim guards, but there's no reason to spin on it here).
    if (
      outcome === 'settled' ||
      outcome === 'failed' ||
      outcome === 'no_vault' ||
      outcome === 'claimed_elsewhere'
    ) {
      break;
    }
    if (noForwardProgress) {
      // No forward progress this pass (e.g. lost the per-step collect
      // claim to a concurrent driver) — stop spinning inline, let the
      // sweep finish it.
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
//
// Pages once per incident when any row has sat in `pending`/`collecting`/
// `redeemed` past the threshold. Single-flighted fleet-wide via
// `pg_try_advisory_xact_lock`, fire-once/re-arm state persisted in
// `watchdog_alert_state`, confirmed-delivery (persist active=true only
// after the send resolves) — the exact shape of the sibling emission
// watchdog and `stuck-payout-watchdog.ts`.
//
// MNY-15: `pending` is covered too, not just the post-CAS in-flight
// states. A `pending` row is a user-OWED redemption claimed at
// `claimVaultRedemption` with nothing on-chain yet (the source order is
// still `pending_payment`, the `user_credits` liability not yet debited
// — the user is owed their money-out). It is normally transient — the
// next sweep tick CASes it `pending → collecting` within ~one tick
// (`SWEEP_STATES` includes `pending`) — but if the vault for its
// (asset, network) is DEREGISTERED, `driveOneVaultRedemption` returns
// `no_vault` at the top and leaves the row in `pending` indefinitely
// (the sweep re-considers it every tick but can never advance it; it
// never exhausts attempts, so it never reaches `failed` and never
// pages). Omitting `pending` here made that stranded, money-owed
// redemption silently invisible — the exact money-owed hole this
// watchdog exists to close. The shared staleness threshold (default
// 15 min ≫ the ~30s sweep cadence) is ANDed uniformly across states, so
// a healthy, momentarily-`pending` row is never false-paged.

const VAULT_REDEMPTION_STUCK_STATES = ['pending', 'collecting', 'redeemed'] as const;
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
