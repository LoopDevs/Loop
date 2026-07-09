/**
 * Admin-mediated late-deposit refund-to-sender (hardening A6; ADR 010).
 *
 * A deposit that lands just after its order expires is recorded in
 * `payment_watcher_skips` (with the `order_gone` reason — T0-1, which
 * closed the gap where such late/duplicate deposits were only counted
 * and never recorded) and abandoned with an attributed Discord alert —
 * visible, but the funds sit at the deposit account until an operator
 * acts. This module returns them to their on-chain sender.
 *
 * It is deliberately ADMIN-MEDIATED (not automatic): the plan flagged
 * the outbound payment `[D]`, and the operator's explicit, step-up-
 * gated trigger IS the per-instance authorization. Since the deposit
 * account == the operator account (CF-18), the refund is an ordinary
 * operator→sender payment — the exact primitive the payout worker
 * runs — so it reuses `submitPayout` / `submitNativePayment`.
 *
 * Idempotency / crash-safety — DOUBLE-REFUND IS THE #1 hazard here
 * (value leaves the system), so the guard mirrors the payout worker:
 *   - Before EVERY submit, ask Horizon whether a refund for this
 *     deposit already landed: WINDOWLESS `getOutboundPaymentByTxHash`
 *     on the persisted `refund_tx_hash` first (the CF-18 hook records
 *     it before the network submit, precisely in the lost-response
 *     case), then a `findOutboundPaymentByMemo` scan (memo + to +
 *     amount + asset) as the first-attempt fallback. If either shows a
 *     landed refund → converge to `refunded`, never send again — even
 *     after a row was released to `abandoned`. A read failure FAILS
 *     CLOSED (never submit under uncertainty).
 *   - `claimForRefund` CAS-moves `abandoned → refunding` under the row
 *     lock (or re-claims a `refunding` row only when it is stale AND
 *     the pre-check confirmed nothing landed), so concurrent callers
 *     can't double-submit.
 *   - On an AMBIGUOUS submit error (`transient_horizon` / a failed
 *     post-scan) the row is LEFT in `refunding` — not released — so a
 *     retry's pre-check converges once Horizon indexes. Only a
 *     definitively-rejected submit releases back to `abandoned`.
 *   - the CF-18 `onSigned` hook still persists the tx hash before
 *     submit for observability.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditTransactions, orders, paymentWatcherSkips } from '../db/schema.js';
import { logger } from '../logger.js';
import { HorizonPaymentSchema } from './horizon.js';
import { parseStroops } from './stroops.js';
import { submitPayout, submitNativePayment, PayoutSubmitError } from './payout-submit.js';
import { findOutboundPaymentByMemo, getOutboundPaymentByTxHash } from './horizon-find-outbound.js';
import { resolvePayoutConfig } from './payout-worker.js';

const log = logger.child({ area: 'deposit-refund' });

/**
 * A `refunding` row this old whose refund is confirmed NOT to have
 * landed on-chain (the memo scan found nothing) is treated as a stuck
 * prior attempt and re-claimed. 5 min is far past Horizon's ~5s
 * indexing lag, so "no landed refund after 5 min" definitively means
 * the prior submit never broadcast — re-submitting cannot double-pay.
 */
const REFUND_RECLAIM_STALE_MS = 5 * 60 * 1000;

/**
 * Dust floor (stroops) below which a deposit is not auto/one-click
 * refundable: the Stellar fee to refund would be a large fraction of
 * the value, so a flood of tiny spam deposits could otherwise bleed the
 * operator's XLM one base-fee at a time (money-review P2). 10_000
 * stroops (0.001 unit) sits well under a real order deposit (the
 * smallest e2e order is $0.02 = 200_000 stroops) while dropping true
 * dust.
 */
export const REFUND_MIN_STROOPS = 10_000n;

export type RefundResult =
  | { kind: 'refunded'; txHash: string }
  | { kind: 'already_refunded'; txHash: string }
  | { kind: 'in_progress' }
  | { kind: 'not_found' }
  | { kind: 'not_refundable'; detail: string }
  | { kind: 'submit_failed'; detail: string };

/** The refund destination + asset + amount, extracted from the deposit. */
interface RefundIntent {
  to: string;
  isNative: boolean;
  assetCode: string;
  assetIssuer: string;
  amountDecimal: string;
  amountStroops: bigint;
}

/**
 * Derive the refund intent from a stored Horizon deposit record.
 * Returns a string reason when the payment can't be safely refunded
 * (no sender, no amount, self-issued/no-issuer asset).
 */
export function refundIntentFromPayment(payment: unknown): RefundIntent | string {
  const parsed = HorizonPaymentSchema.safeParse(payment);
  if (!parsed.success) return 'stored payment failed schema validation';
  const p = parsed.data;
  // KNOWN RESIDUAL (AUDIT-2 finding C, 2026-07): the watcher now records
  // `path_payment_strict_send`/`path_payment_strict_receive` deposits
  // (as `order_gone` or the new `unrecognized_deposit`) since they
  // deliver value identically to a plain `payment` op — but this A6
  // refund path still only handles `type === 'payment'`. A path-payment
  // skip row is therefore VISIBLE (the goal of this PR) but not yet
  // refundable through this automated flow — refunding it needs the
  // same "reverse a path payment" handling `submitPayout` doesn't have
  // today. Left as a follow-up; not blocking, since the money sits safe
  // at the deposit/operator account either way (INV-6 holds via
  // visibility, not yet via one-click refund for this op type).
  if (p.type !== 'payment') return `not a payment op (type=${p.type})`;
  if (p.from === undefined || p.from === '') return 'no sender address on the deposit';
  if (p.amount === undefined) return 'no amount on the deposit';
  let amountStroops: bigint;
  try {
    amountStroops = parseStroops(p.amount);
  } catch {
    return `unparseable amount "${p.amount}"`;
  }
  if (amountStroops <= 0n) return 'non-positive amount';
  if (amountStroops < REFUND_MIN_STROOPS) {
    return `amount ${p.amount} below the ${REFUND_MIN_STROOPS} stroop refund dust floor`;
  }
  const isNative = p.asset_type === 'native';
  if (!isNative) {
    if (p.asset_code === undefined || p.asset_issuer === undefined) {
      return 'non-native deposit missing asset code/issuer';
    }
  }
  return {
    to: p.from,
    isNative,
    assetCode: isNative ? 'XLM' : p.asset_code!,
    assetIssuer: isNative ? '' : p.asset_issuer!,
    amountDecimal: p.amount,
    amountStroops,
  };
}

/** One refundable skip row (loaded for the admin handler). */
export interface RefundableSkip {
  paymentId: string;
  status: string;
  refundTxHash: string | null;
  payment: unknown;
  updatedAt: Date;
}

export async function loadSkip(paymentId: string): Promise<RefundableSkip | null> {
  const [row] = await db
    .select({
      paymentId: paymentWatcherSkips.paymentId,
      status: paymentWatcherSkips.status,
      refundTxHash: paymentWatcherSkips.refundTxHash,
      payment: paymentWatcherSkips.payment,
      updatedAt: paymentWatcherSkips.updatedAt,
    })
    .from(paymentWatcherSkips)
    .where(eq(paymentWatcherSkips.paymentId, paymentId));
  return row ?? null;
}

export type ClaimForRefundResult = 'claimed' | 'lost' | 'credit_refunded';

/**
 * CAS-claim the row for a submit, under the row lock. Wins iff the row
 * is `abandoned`, OR it is a STALE `refunding` row (a prior attempt
 * older than {@link REFUND_RECLAIM_STALE_MS} whose refund the caller
 * has already confirmed did NOT land — the caller MUST run the memo
 * pre-check first). Two concurrent callers: exactly one wins (the
 * second re-evaluates the WHERE after the first commits and matches 0
 * rows → `'lost'`).
 *
 * INV-8 cross-check (money review 2026-07-08): when the skip row is
 * bound to an order whose OWN paying deposit this is (paymentId equals
 * the order's persisted paying id, or the order has no paying id and
 * cannot be disambiguated — fail closed), the claim refuses with
 * `'credit_refunded'` if a mirror-credit refund row already exists for
 * that order. The check locks the order row FOR UPDATE — the same lock
 * `applyAdminRefund` holds while inserting its credit row — so the two
 * refund exits serialise: whichever commits first is visible to the
 * other. Without this, an admin credit refund plus an A6 one-click
 * deposit refund would pay the user twice for one order.
 */
export async function claimForRefund(paymentId: string): Promise<ClaimForRefundResult> {
  const staleCutoff = sql`NOW() - ${`${REFUND_RECLAIM_STALE_MS} milliseconds`}::interval`;
  return await db.transaction(async (tx) => {
    const [skipRow] = await tx
      .select({ orderId: paymentWatcherSkips.orderId })
      .from(paymentWatcherSkips)
      .where(eq(paymentWatcherSkips.paymentId, paymentId));
    const orderId = skipRow?.orderId ?? null;
    // Lock order first, skip row second — the same order every other
    // refund writer uses, so the lock graph stays acyclic. When the
    // skip row carries no order binding (e.g. a processing_error row
    // recorded before the watcher matched anything), reverse-look-up
    // the order this deposit PAID via its persisted paying id — that
    // is how a null-orderId row still gets the INV-8 exclusion.
    const [order] =
      orderId !== null
        ? await tx
            .select({ id: orders.id, paymentReceivedHorizonId: orders.paymentReceivedHorizonId })
            .from(orders)
            .where(eq(orders.id, orderId))
            .for('update')
        : await tx
            .select({ id: orders.id, paymentReceivedHorizonId: orders.paymentReceivedHorizonId })
            .from(orders)
            .where(eq(orders.paymentReceivedHorizonId, paymentId))
            .for('update');
    if (order !== undefined) {
      const payingId = order.paymentReceivedHorizonId ?? null;
      if (payingId === null || payingId === paymentId) {
        const [creditRefund] = await tx
          .select({ id: creditTransactions.id })
          .from(creditTransactions)
          .where(
            and(
              eq(creditTransactions.type, 'refund'),
              eq(creditTransactions.referenceType, 'order'),
              eq(creditTransactions.referenceId, order.id),
            ),
          );
        if (creditRefund !== undefined) return 'credit_refunded';
      }
    }
    const updated = await tx
      .update(paymentWatcherSkips)
      .set({ status: 'refunding', updatedAt: sql`NOW()` })
      .where(
        and(
          eq(paymentWatcherSkips.paymentId, paymentId),
          sql`(${paymentWatcherSkips.status} = 'abandoned'
            OR (${paymentWatcherSkips.status} = 'refunding' AND ${paymentWatcherSkips.updatedAt} < ${staleCutoff}))`,
        ),
      )
      .returning({ paymentId: paymentWatcherSkips.paymentId });
    return updated.length > 0 ? 'claimed' : 'lost';
  });
}

async function markRefunded(paymentId: string, txHash: string): Promise<void> {
  await db
    .update(paymentWatcherSkips)
    .set({ status: 'refunded', refundTxHash: txHash, updatedAt: sql`NOW()` })
    .where(eq(paymentWatcherSkips.paymentId, paymentId));
}

async function releaseClaim(paymentId: string, err: string): Promise<void> {
  await db
    .update(paymentWatcherSkips)
    .set({ status: 'abandoned', lastError: err.slice(0, 500), updatedAt: sql`NOW()` })
    .where(
      and(
        eq(paymentWatcherSkips.paymentId, paymentId),
        eq(paymentWatcherSkips.status, 'refunding'),
      ),
    );
}

async function persistRefundHash(paymentId: string, txHash: string): Promise<void> {
  await db
    .update(paymentWatcherSkips)
    .set({ refundTxHash: txHash, updatedAt: sql`NOW()` })
    .where(eq(paymentWatcherSkips.paymentId, paymentId));
}

/**
 * Refund an abandoned late deposit back to its on-chain sender.
 * Idempotent + crash-safe per the module docstring. Returns a tagged
 * result the handler maps to an HTTP status.
 */
export async function refundDeposit(paymentId: string): Promise<RefundResult> {
  const skip = await loadSkip(paymentId);
  if (skip === null) return { kind: 'not_found' };
  if (skip.status === 'refunded') {
    return { kind: 'already_refunded', txHash: skip.refundTxHash ?? '' };
  }
  if (skip.status !== 'abandoned' && skip.status !== 'refunding') {
    return { kind: 'not_refundable', detail: `skip status is '${skip.status}'` };
  }

  const intent = refundIntentFromPayment(skip.payment);
  if (typeof intent === 'string') return { kind: 'not_refundable', detail: intent };

  // Operator signer must be configured (deposit account == operator).
  const cfg = resolvePayoutConfig();
  if (cfg === null) {
    return { kind: 'not_refundable', detail: 'operator Stellar signer not configured' };
  }

  // Deterministic, ≤28-byte Stellar text memo — the idempotency key on
  // the operator account's payment history.
  const memoText = `rfnd:${paymentId}`.slice(0, 28);
  const expectedAssetCode = intent.isNative ? null : intent.assetCode;
  const scanArgs = {
    account: cfg.operatorAccount,
    to: intent.to,
    memo: memoText,
    expectedAmountStroops: intent.amountStroops,
    expectedAssetCode,
  };

  /**
   * Has a refund for THIS deposit already landed on-chain? Returns the
   * landed hash, `null` (definitely nothing landed), or `'unknown'` (a
   * Horizon read threw — caller FAILS CLOSED). Money-review P0 + P1:
   *   1. WINDOWLESS first — if a prior attempt persisted `refund_tx_hash`
   *      (via the CF-18 onSigned hook, which fires precisely in the
   *      lost-response case), ask `GET /transactions/{hash}` directly. On
   *      the shared deposit==operator account the payments feed is busy,
   *      so the bounded memo scan could scroll a landed refund out of
   *      window — the hash lookup has no window.
   *   2. Memo scan as the fallback for the first-attempt case (no hash
   *      persisted yet) and as belt-and-braces for a refund whose hash
   *      we didn't record.
   */
  const findLandedRefund = async (
    hash: string | null,
  ): Promise<{ txHash: string } | null | 'unknown'> => {
    if (hash !== null) {
      try {
        const res = await getOutboundPaymentByTxHash(hash);
        if (res?.landed === true) return { txHash: hash };
      } catch {
        return 'unknown';
      }
    }
    try {
      return await findOutboundPaymentByMemo(scanArgs);
    } catch {
      return 'unknown';
    }
  };

  // ── THE double-pay guard (money-review P0/P1) ─────────────────────
  // Before ANY submit, converge if a refund for this deposit already
  // landed. A read failure FAILS CLOSED — never submit under uncertainty.
  const prior = await findLandedRefund(skip.refundTxHash);
  if (prior === 'unknown') {
    log.warn({ paymentId }, 'A6: refund idempotency pre-check failed — not submitting');
    return { kind: 'in_progress' };
  }
  if (prior !== null) {
    await markRefunded(paymentId, prior.txHash);
    return { kind: 'already_refunded', txHash: prior.txHash };
  }

  // No refund has landed. Claim the row for submit: wins if it is
  // `abandoned`, or a `refunding` row stale past REFUND_RECLAIM_STALE_MS
  // (a prior attempt that — per the pre-check just above — never landed,
  // so re-submitting is safe). A fresh `refunding` row (concurrent or
  // recent attempt) loses the claim → in_progress. A skip row whose
  // order was already refunded as a mirror credit refuses the claim
  // outright (INV-8 cross-check — see claimForRefund).
  const claim = await claimForRefund(paymentId);
  if (claim === 'credit_refunded') {
    return {
      kind: 'not_refundable',
      detail: 'order was already refunded as a mirror credit (INV-8 cross-check)',
    };
  }
  if (claim === 'lost') {
    return { kind: 'in_progress' };
  }

  // Capture the signed hash (CF-18) so the post-error re-scan can do a
  // WINDOWLESS lookup on the exact tx we just tried to submit.
  let signedHash: string | null = null;
  const onSigned = async (txHash: string): Promise<void> => {
    signedHash = txHash;
    await persistRefundHash(paymentId, txHash);
  };
  try {
    let txHash: string;
    if (intent.isNative) {
      const res = await submitNativePayment({
        secret: cfg.operatorSecret,
        horizonUrl: cfg.horizonUrl,
        networkPassphrase: cfg.networkPassphrase,
        intent: { to: intent.to, amount: intent.amountDecimal, memoText },
        onSigned,
      });
      txHash = res.txHash;
    } else {
      const res = await submitPayout({
        secret: cfg.operatorSecret,
        horizonUrl: cfg.horizonUrl,
        networkPassphrase: cfg.networkPassphrase,
        intent: {
          to: intent.to,
          assetCode: intent.assetCode,
          assetIssuer: intent.assetIssuer,
          amountStroops: intent.amountStroops,
          memoText,
        },
        onSigned,
      });
      txHash = res.txHash;
    }
    await markRefunded(paymentId, txHash);
    log.warn(
      { paymentId, to: intent.to, assetCode: intent.assetCode, amount: intent.amountDecimal },
      'A6: late deposit refunded to sender',
    );
    return { kind: 'refunded', txHash };
  } catch (err) {
    const kind = err instanceof PayoutSubmitError ? err.kind : 'unknown';
    const detail = err instanceof PayoutSubmitError ? `${err.kind}: ${err.message}` : String(err);
    // Did the tx land despite the error? Re-check (windowless on the
    // just-signed hash first). If it landed, this was a lost-response,
    // not a failure — converge to success.
    const landedAfter = await findLandedRefund(signedHash);
    if (landedAfter !== null && landedAfter !== 'unknown') {
      await markRefunded(paymentId, landedAfter.txHash);
      return { kind: 'refunded', txHash: landedAfter.txHash };
    }
    // Release ONLY when the error is a DEFINITIVELY-rejected submit
    // (`transient_rebuild` / `terminal_*` — the tx never entered a
    // ledger) AND the post-scan succeeded (didn't throw). Everything
    // else — `transient_horizon` (lost response), a non-classified
    // error (e.g. onSigned threw), or a failed post-scan — is
    // AMBIGUOUS: the tx might have landed but isn't visible yet. Hold
    // the row in `refunding` (fail-closed) so a later retry's pre-check
    // converges once Horizon indexes, or the stale-reclaim re-submits
    // if it truly never landed. Never release under uncertainty.
    const definitivelyRejected =
      err instanceof PayoutSubmitError && kind !== 'transient_horizon' && landedAfter !== 'unknown';
    if (!definitivelyRejected) {
      log.error(
        { err, paymentId, kind },
        'A6: refund submit ambiguous — holding in refunding (fail-closed)',
      );
      return { kind: 'in_progress' };
    }
    log.error({ err, paymentId }, 'A6: deposit refund rejected — releasing claim');
    await releaseClaim(paymentId, detail);
    return { kind: 'submit_failed', detail };
  }
}
