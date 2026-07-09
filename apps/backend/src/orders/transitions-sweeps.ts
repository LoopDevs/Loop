/**
 * Bulk-state-flipper sweeps for the order state machine
 * (ADR 010 / A2-621 / A2-708).
 *
 * Lifted out of `apps/backend/src/orders/transitions.ts` so the
 * two background sweeps live in their own focused module
 * separate from the per-order transition functions
 * (`markOrderPaid` / `markOrderProcuring` / `markOrderFulfilled`
 * / `markOrderFailed`) in the parent file:
 *
 *   - `sweepStuckProcurement(cutoff)` — flips procuring rows
 *     older than the cutoff to `failed` with reason
 *     `procurement_timeout`. Hardening A5: disambiguates each row
 *     via the durable CTX-settlement record + authoritative Horizon
 *     hash lookup (`loopPaidCtx`) and AUTO-REFUNDS the rows where
 *     Loop never paid CTX (the common crashed-worker case), leaving
 *     only the genuinely-paid rows for manual reconcile.
 *   - `sweepExpiredOrders(cutoff)` — flips pending_payment
 *     rows older than the cutoff to `expired`.
 *
 * Re-exported from `transitions.ts` so the existing import
 * path (`'../orders/transitions.js'`) used by procurement.ts,
 * payments/watcher.ts, and the test suite (including its
 * dynamic `await import('../transitions.js')`) keeps working
 * unchanged.
 */
import { and, eq, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { notifyOrderFailedAfterCtxPaid } from '../discord.js';
import { getCtxSettlementByOrderId, markCtxSettlementConfirmed } from './ctx-settlements.js';
import { getOutboundPaymentByTxHash } from '../payments/horizon.js';
import {
  applyOrderAutoRefund,
  RefundAlreadyIssuedError,
  RefundOrderInvalidError,
} from '../credits/refunds.js';
import { logger } from '../logger.js';

const log = logger.child({ area: 'stuck-procurement-sweep' });

/**
 * Did Loop actually pay CTX for this order? (hardening A5.)
 *
 * The subtlety the first draft got wrong: `confirmedAt` is written
 * AFTER the network submit round-trips, but the tx hash is persisted
 * BEFORE it (CF-18 `onSigned`). So a worker that crashed AFTER the
 * payment landed but before the confirm-write leaves `tx_hash` set /
 * `confirmed_at` NULL — the exact crashed-worker population this sweep
 * exists to clean up. Keying on `confirmedAt` would misclassify those
 * as unpaid and double-refund a user who has a usable card.
 *
 * So we key on the durable hash + the authoritative Horizon point
 * lookup, exactly as `payCtxOrder` does before it trusts anything:
 *
 *   - no settlement row, or a row with no `tx_hash` → nothing was ever
 *     signed/dispatched → Loop did NOT pay.
 *   - `confirmed_at` already set → paid (fast path, no Horizon call).
 *   - `tx_hash` set, unconfirmed → ask Horizon whether that exact tx
 *     landed. Landed → paid (and backfill `confirmed_at`); genuinely
 *     never-landed → not paid.
 *   - ANY read failure (DB or Horizon) → treat as PAID and hold —
 *     uncertainty must never auto-refund (the double-spend direction).
 *
 * Exported (A5-1) so the admin order re-drive endpoint
 * (`admin/order-redrive.ts`) can reuse the SAME disambiguation before
 * reverting a stuck `procuring` order back to `paid` for a re-drive —
 * redriving an order Loop already paid CTX for would have
 * `procureOne` create a second CTX gift-card order (INV-7's
 * `ctx_settlements` guard refuses to pay it, so it can't double-pay,
 * but it's a wasteful, confusing failure the redrive should refuse
 * up front instead).
 */
export async function loopPaidCtx(orderId: string): Promise<boolean> {
  const settlement = await getCtxSettlementByOrderId(orderId);
  if (settlement === null || settlement.txHash === null) return false;
  if (settlement.confirmedAt !== null) return true;
  const landed = await getOutboundPaymentByTxHash(settlement.txHash);
  if (landed?.landed === true) {
    await markCtxSettlementConfirmed(settlement.id);
    return true;
  }
  // landed=false (on chain but failed) or null (never landed) → the
  // signed tx did not settle, so CTX was not paid.
  return false;
}

/**
 * Bulk transition: any procuring rows older than `cutoff` →
 * `failed` (reason `procurement_timeout`). Called by the
 * procurement worker on a periodic tick — handles the case
 * where a worker crashed mid-procurement and the row would
 * otherwise sit stuck in `procuring` forever, blocking the
 * user from a retry and skewing the live-orders aggregate.
 *
 * Hardening A5 — refund disambiguation. Every other failure path in
 * `procureOne` auto-refunds; this sweep was the one that stranded a
 * paid user (flip to failed, Discord embed, manual reconcile) because
 * a crashed worker leaves the "did CTX get paid?" question
 * unanswerable from in-memory state. The durable CTX-settlement record
 * (hardening A4) answers it from the DB:
 *
 *   - Loop did NOT pay CTX (`loopPaidCtx` false — no settlement, or a
 *     signed tx that never landed) → CTX delivers no unpaid card, so
 *     refunding the user leaves everyone whole. AUTO-REFUND, same as
 *     every sibling failure path.
 *   - Loop DID pay CTX → the card may be deliverable. Refunding would
 *     leave Loop out-of-pocket against a usable card. HOLD (no refund)
 *     for manual reconcile.
 *
 * Every swept row pages ops via `notifyOrderFailedAfterCtxPaid` whose
 * title encodes the ctxPaid × refunded matrix — so a wrongly-stuck
 * row can never be silently refunded without on-call seeing it.
 *
 * Failure reason is set to `procurement_timeout` so a later audit
 * can differentiate genuine CTX rejections from crashed-worker
 * orphans. Returns the count swept.
 *
 * Safe against a live worker: the `state = 'procuring'` guard on the
 * UPDATE means a tick that reaches `markOrderFulfilled` after this
 * sweep sees the row already failed (null return → caller logs and
 * moves on, no ledger write).
 */
export async function sweepStuckProcurement(cutoff: Date): Promise<number> {
  const now = new Date();
  const rows = await db
    .update(orders)
    .set({
      state: 'failed',
      failureReason: 'procurement_timeout',
      failedAt: now,
    })
    .where(and(eq(orders.state, 'procuring'), lt(orders.procuredAt, cutoff)))
    .returning({
      id: orders.id,
      userId: orders.userId,
      merchantId: orders.merchantId,
      chargeMinor: orders.chargeMinor,
      chargeCurrency: orders.chargeCurrency,
      paymentMethod: orders.paymentMethod,
      paymentMemo: orders.paymentMemo,
      paymentReceivedHorizonId: orders.paymentReceivedHorizonId,
      paymentReceivedPayment: orders.paymentReceivedPayment,
      ctxOperatorId: orders.ctxOperatorId,
      procuredAt: orders.procuredAt,
    });

  // Per-row disambiguation AFTER the commit — the state flip is the
  // load-bearing change; refund/alert are side effects.
  for (const row of rows) {
    let ctxPaid: boolean;
    try {
      ctxPaid = await loopPaidCtx(row.id);
    } catch (err) {
      // A read failure (DB or Horizon) means we cannot conclude Loop
      // didn't pay — fail closed to hold. Uncertainty must never
      // auto-refund (the double-spend direction).
      log.error(
        { err, orderId: row.id },
        'A5: settlement/Horizon lookup failed during sweep — treating as ctx-paid (hold)',
      );
      ctxPaid = true;
    }

    let refunded = false;
    if (!ctxPaid) {
      // Loop never paid CTX — auto-refund like every other failure
      // path. Non-throwing: a refund blip must not abort the loop.
      try {
        await applyOrderAutoRefund({
          userId: row.userId,
          currency: row.chargeCurrency,
          amountMinor: row.chargeMinor,
          orderId: row.id,
          paymentMethod: row.paymentMethod,
          paymentMemo: row.paymentMemo,
          paymentReceivedHorizonId: row.paymentReceivedHorizonId,
          paymentReceivedPayment: row.paymentReceivedPayment,
          reason: `procurement stuck-sweep, CTX unpaid: order timed out in procuring`,
        });
        refunded = true;
        log.warn(
          { orderId: row.id, userId: row.userId, chargeMinor: row.chargeMinor.toString() },
          'A5: stuck procuring order (CTX unpaid) auto-refunded',
        );
      } catch (refundErr) {
        if (refundErr instanceof RefundAlreadyIssuedError) {
          refunded = true;
          log.warn({ orderId: row.id }, 'A5: stuck-sweep order already refunded');
        } else if (refundErr instanceof RefundOrderInvalidError) {
          log.error(
            { orderId: row.id, reason: refundErr.reason },
            'A5: auto-refund rejected as invalid during sweep — manual refund needed',
          );
        } else {
          log.error(
            { err: refundErr, orderId: row.id },
            'A5: auto-refund threw during sweep — user NOT refunded; manual intervention needed',
          );
        }
      }
    }

    // Page ops for EVERY swept row (a non-zero sweep is rare and each
    // row is a distinct incident). The notifier title encodes the full
    // matrix: ctxPaid × refunded — so on-call sees a
    // "CTX debt open" hold, a clean "not paid → refunded", and (the
    // loud one) a "refund FAILED" row that needs a human. Fire-and-
    // forget AFTER the commit + refund attempt.
    notifyOrderFailedAfterCtxPaid({
      orderId: row.id,
      ctxOrderId: null,
      userId: row.userId,
      chargeMinor: row.chargeMinor.toString(),
      chargeCurrency: row.chargeCurrency,
      reason: 'procurement stuck-sweep (worker crashed mid-procurement)',
      refunded,
      ctxPaid,
    });
  }
  return rows.length;
}

/**
 * Bulk transition: any pending_payment rows older than `cutoff` →
 * `expired`. Called by the payment watcher tick. A row that
 * never received its on-chain payment ages out and is closed off
 * so the live-orders aggregate doesn't grow forever.
 */
export async function sweepExpiredOrders(cutoff: Date): Promise<number> {
  const rows = await db
    .update(orders)
    .set({
      state: 'expired',
      failedAt: new Date(),
    })
    .where(and(eq(orders.state, 'pending_payment'), lt(orders.createdAt, cutoff)))
    .returning({ id: orders.id });
  return rows.length;
}
