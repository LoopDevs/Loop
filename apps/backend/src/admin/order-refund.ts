/**
 * Order-bound admin refund (A5-4 — readiness-backlog §Tier 5).
 *
 * `POST /api/admin/orders/:orderId/refund` — the operator-decided policy
 * (readiness-backlog A5-4, 2026-07-10): a `paid` / `procuring` / `failed`
 * order refunds directly. A `fulfilled` order (the user already received
 * the gift-card code) is ALSO refundable, but ONLY behind a required
 * code-unused attestation — the operator affirms the delivered code is
 * unused/unusable. This is the accepted compensating control for the
 * double-spend risk (the user could keep the code AND get refunded) that
 * stands in for CTX redemption-verification, which Loop doesn't have yet
 * (see `docs/threat-model.md`'s accepted-risk register). `pending_payment`
 * / `expired` orders (nothing was ever collected, or nothing left to
 * reverse) are rejected, as is an order that already carries a refund.
 *
 * Deliberately reuses the SAME primitives the existing auto-refund path
 * (`credits/refunds.ts`) already uses — this is NOT a new money path:
 *
 *   - `xlm` / `usdc` → `applyOrderAutoRefund` dispatches to the on-chain
 *     refund-to-sender machinery (`payments/deposit-refund.ts`'s A6
 *     `refundDeposit`), reusing the order's stored payment snapshot
 *     (`paymentReceivedHorizonId` / `paymentReceivedPayment`, R3-2). A
 *     pre-migration order with no snapshot fails closed (502) — refund
 *     it manually, same posture `applyOrderAutoRefund` already has for
 *     the automatic failed-order path.
 *   - `credit`       → `applyAdminRefund` (the mirror-credit refund,
 *     ADR 017), with the REAL admin actor (not the synthetic
 *     `AUTO_REFUND_SYSTEM_ACTOR` `applyOrderAutoRefund` stamps for its
 *     credit branch — this is an operator-attributed write).
 *   - `loop_asset`   → FAILS CLOSED (409) — matches the existing R3-2
 *     posture (re-mint/re-credit semantics for a LOOP-asset-funded
 *     order aren't implemented; escalate for a manual money-review
 *     refund rather than inventing a new path here).
 *
 * INV-8 (single-issue-per-order refund): relies entirely on the SAME
 * guards `applyAdminRefund` / `applyOnChainOrderAutoRefund` already
 * enforce (the migration-0013 partial unique index, and the cross-check
 * against the other refund exit via the order-row lock) — this handler
 * adds no new uniqueness logic. A second call for an already-refunded
 * order surfaces `RefundAlreadyIssuedError` → 409 `ORDER_ALREADY_REFUNDED`.
 *
 * `paid` / `procuring` orders are fenced to `failed` (`markOrderFailed`)
 * as PART of the refund, BEFORE the refund primitive runs — the same
 * state-flip-first-refund-second order `sweepStuckProcurement` already
 * uses. Without this, the procurement worker / the A5-1 redrive lever
 * could later pick up the (still `paid`) order and pay CTX for a gift
 * card whose payment was just refunded — a genuine unbacked-value loss.
 * A `procuring` order carries TWO extra gates, together making its
 * refund exactly as safe as `sweepStuckProcurement`'s auto-refund (which
 * is the only other writer that refunds a `procuring` order):
 *   1. `loopPaidCtx()` (exported from `orders/transitions-sweeps.ts`,
 *      the SAME disambiguation the sweep uses) must confirm Loop has NOT
 *      already paid CTX — refunding a CTX-paid order double-loses money
 *      (CTX paid AND the customer refunded); refused with 409
 *      `ORDER_REFUND_CTX_ALREADY_PAID`.
 *   2. `procured_at` must be older than `PROCUREMENT_TIMEOUT_MS` (the
 *      sweep's own terminal cutoff). This closes the live-worker TOCTOU
 *      the A5-1 redrive refused `procuring` orders over: a FRESH
 *      `procuring` order may have a worker mid-flight between
 *      `markOrderProcuring` and `payCtxOrder` — during that short window
 *      `loopPaidCtx` reads `false` (no `ctx_settlements` row yet) but the
 *      worker is about to pay CTX with no order-state re-check, so
 *      fencing + refunding it would double-lose. Requiring the same
 *      15-min staleness the sweep requires means we only ever refund a
 *      `procuring` order a crashed/dead worker left behind (a still-alive
 *      worker cannot plausibly sit before `payCtxOrder` for 15 min — the
 *      CTX POST has a 30s timeout; a worker hung INSIDE `payCtxOrder`
 *      would have persisted a `tx_hash`, which `loopPaidCtx` then catches
 *      via gate 1). A not-yet-stale `procuring` order is refused with 400
 *      `ORDER_NOT_REFUNDABLE` ("still actively procuring — wait"). This
 *      endpoint never force-reverts a live `procuring` order.
 *
 * `failed` orders are already terminal (no state mutation needed).
 * `fulfilled` orders keep their state — there is no `refunded` order
 * state in the state machine; the ledger (a `credit_transactions`
 * `type='refund'` row, or a `payment_watcher_skips` refunded row) IS
 * the durable refund record, exactly as `applyOrderAutoRefund` already
 * relies on for the automatic path.
 *
 * ADR 017 envelope (Idempotency-Key + required reason + Discord audit)
 * plus ADR 028 step-up (`'order-refund'` scope, admin-tier only) — same
 * classification as the sibling A5-1 `order-redrive` lever: this can
 * submit a real outbound Stellar payment, so it's a money write, not a
 * delivery-unsticking read-drive.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import type { AdminOrderRefundResult } from '@loop/shared';
import { UUID_RE } from '../uuid.js';
import type { User } from '../db/users.js';
import { getOrderById } from '../orders/repo.js';
import { markOrderFailedFromState } from '../orders/transitions.js';
import { loopPaidCtx } from '../orders/transitions-sweeps.js';
import { PROCUREMENT_TIMEOUT_MS } from '../orders/procurement-constants.js';
import {
  applyAdminRefund,
  applyOrderAutoRefund,
  RefundAlreadyIssuedError,
  RefundOrderInvalidError,
} from '../credits/refunds.js';
import { DailyAdjustmentLimitError } from '../credits/adjustments.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  validateIdempotencyKey,
  withIdempotencyGuard,
} from './idempotency.js';

const log = logger.child({ handler: 'admin-order-refund' });

/**
 * Order states a refund can be issued from directly (`paid` /
 * `procuring` / `failed`) or behind the attestation (`fulfilled`).
 * `pending_payment` (nothing was ever collected) and `expired` (lapsed,
 * same reason) are excluded — the CHECK `orders_state_known` guarantees
 * `order.state` is one of these six, so anything not in this set falls
 * through to the same 400.
 */
const REFUNDABLE_STATES = new Set(['paid', 'procuring', 'failed', 'fulfilled']);

const AttestationSchema = z.object({
  // Literal `true` only — the wire shape makes "yes, attested" the only
  // value the schema accepts, so a client can't submit `false` and have
  // it silently treated as "no attestation" vs. an explicit rejection.
  codeUnused: z.literal(true),
  attestationNote: z.string().min(2).max(500),
});

const BodySchema = z.object({
  reason: z.string().min(2).max(500),
  attestation: AttestationSchema.optional(),
});

/**
 * Control-flow escape for the not-applicable outcomes — thrown from
 * inside the idempotency guard so no failure snapshot is stored (a
 * transient-state 400/409 must never replay once the order's real state
 * has moved on) — same pattern as `order-redrive.ts`.
 */
class OrderRefundNotApplicableError extends Error {
  constructor(
    readonly kind:
      | 'order_not_found'
      | 'not_refundable'
      | 'procuring_not_stale'
      | 'attestation_required'
      | 'unsupported_payment_method'
      | 'ctx_already_paid'
      | 'state_changed',
    readonly orderState?: string,
  ) {
    super(`order refund not applicable: ${kind}`);
    this.name = 'OrderRefundNotApplicableError';
  }
}

/**
 * The on-chain refund primitive threw something other than the two
 * typed cross-check errors — a missing payment snapshot (pre-migration
 * order) or a non-refunded `refundDeposit` outcome (submit failed / not
 * refundable / in flight). The order was already fenced to `failed`
 * (or was already terminal) before this runs, so a retry via this SAME
 * endpoint is safe once the underlying issue (e.g. a transient Horizon
 * failure) clears.
 */
class OrderRefundSubmitFailedError extends Error {}

export async function adminRefundOrderHandler(c: Context): Promise<Response> {
  const orderId = c.req.param('orderId');
  if (orderId === undefined || !UUID_RE.test(orderId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'orderId must be a uuid' }, 400);
  }
  const idempotencyKey = c.req.header('idempotency-key');
  if (!validateIdempotencyKey(idempotencyKey)) {
    return c.json(
      {
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: `Idempotency-Key header required (${IDEMPOTENCY_KEY_MIN}-${IDEMPOTENCY_KEY_MAX} chars)`,
      },
      400,
    );
  }
  const actor = c.get('user') as User | undefined;
  if (actor === undefined) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Admin context missing' }, 401);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' }, 400);
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid body' },
      400,
    );
  }
  const { reason, attestation } = parsed.data;

  let guardResult: Awaited<ReturnType<typeof withIdempotencyGuard>>;
  try {
    guardResult = await withIdempotencyGuard(
      {
        adminUserId: actor.id,
        key: idempotencyKey,
        method: 'POST',
        path: `/api/admin/orders/${orderId}/refund`,
      },
      async () => {
        const order = await getOrderById(orderId);
        if (order === null) {
          throw new OrderRefundNotApplicableError('order_not_found');
        }
        if (!REFUNDABLE_STATES.has(order.state)) {
          throw new OrderRefundNotApplicableError('not_refundable', order.state);
        }

        // loop_asset fails closed BEFORE any state mutation, regardless
        // of the order's state (R3-2 posture) — never fence an order
        // out of procurement for a refund this endpoint then can't
        // actually perform.
        if (order.paymentMethod === 'loop_asset') {
          throw new OrderRefundNotApplicableError('unsupported_payment_method');
        }

        const attested = order.state === 'fulfilled';
        if (attested && attestation === undefined) {
          throw new OrderRefundNotApplicableError('attestation_required');
        }

        if (order.state === 'procuring') {
          // Gate 2 (see the module docstring): only refund a `procuring`
          // order once it is as stale as the recovery sweep's terminal
          // cutoff. A fresh procuring order may have a live worker
          // mid-flight before `payCtxOrder` (loopPaidCtx would read false
          // yet CTX is about to be paid with no order-state re-check) —
          // fencing + refunding it would double-lose. 15-min staleness
          // means only a crashed/dead worker's leftover row is
          // refundable here.
          const procuredAtMs = order.procuredAt?.getTime() ?? null;
          const staleEnough =
            procuredAtMs !== null && Date.now() - procuredAtMs >= PROCUREMENT_TIMEOUT_MS;
          if (!staleEnough) {
            throw new OrderRefundNotApplicableError('procuring_not_stale', order.state);
          }
          // Gate 1: sweepStuckProcurement's SAME disambiguation — refuse
          // rather than double-lose money (CTX paid AND customer refunded).
          const ctxPaid = await loopPaidCtx(order.id);
          if (ctxPaid) {
            throw new OrderRefundNotApplicableError('ctx_already_paid');
          }
        }

        // Fence `paid` / `procuring` orders out of procurement BEFORE
        // any money moves. `failed` is already terminal; `fulfilled`
        // keeps its state (no `refunded` order state exists — the
        // ledger record IS the refund, same as `applyOrderAutoRefund`).
        //
        // CRITICAL (money review 2026-07-10): the CAS is pinned to the
        // EXACT state we validated (`markOrderFailedFromState`, not the
        // broad `markOrderFailed`). If a worker transitioned the order
        // `paid → procuring` in the gap since our read, the pinned
        // `WHERE state='paid'` fence matches 0 rows → `null` → we refuse
        // (state_changed) and refund NOTHING. The broad predicate would
        // instead have fenced the now-`procuring` row while that worker
        // goes on to pay CTX with no order-state re-check — a double-loss.
        // For the `procuring` branch the same pin means an intervening
        // `procuring → fulfilled` also converges to a clean 409.
        if (order.state === 'paid' || order.state === 'procuring') {
          const fenced = await markOrderFailedFromState(
            order.id,
            order.state,
            `admin-refund (${actor.email}): ${reason}`.slice(0, 500),
          );
          if (fenced === null) {
            // Raced past us since the read above (a worker claimed a
            // `paid` order into `procuring`, reached `fulfilled`, or the
            // recovery sweep already failed it). Refuse cleanly rather
            // than refund a state we no longer believe is accurate — the
            // caller re-POSTs with a FRESH Idempotency-Key so the
            // (now-current) state is re-validated.
            throw new OrderRefundNotApplicableError('state_changed');
          }
        }

        // Durable reason text (persisted on the ledger row / skip-row
        // detail — NOT just the 24h idempotency snapshot or Discord).
        // Front-loads the attestation marker so it survives the 500-char
        // truncation even on a maximal-length reason.
        const auditReason =
          attested && attestation !== undefined
            ? `[FULFILLED-ORDER REFUND — code-unused attestation confirmed] ${reason} :: attestation note: ${attestation.attestationNote}`.slice(
                0,
                500,
              )
            : reason;

        let refundMethod: AdminOrderRefundResult['refundMethod'];
        let onChain: AdminOrderRefundResult['onChain'] = null;
        let mirrorCredit: AdminOrderRefundResult['mirrorCredit'] = null;

        if (order.paymentMethod === 'xlm' || order.paymentMethod === 'usdc') {
          refundMethod = 'onchain_deposit_refund';
          let outcome;
          try {
            outcome = await applyOrderAutoRefund({
              userId: order.userId,
              currency: order.chargeCurrency,
              amountMinor: order.chargeMinor,
              orderId: order.id,
              paymentMethod: order.paymentMethod,
              paymentMemo: order.paymentMemo,
              paymentReceivedHorizonId: order.paymentReceivedHorizonId,
              paymentReceivedPayment: order.paymentReceivedPayment,
              reason: auditReason,
            });
          } catch (err) {
            if (err instanceof RefundAlreadyIssuedError || err instanceof RefundOrderInvalidError) {
              throw err;
            }
            // Missing payment snapshot (pre-migration order) or a
            // non-refunded `refundDeposit` outcome — both surfaced as a
            // plain Error by the on-chain branch.
            log.error({ err, orderId: order.id }, 'A5-4: on-chain refund submit failed');
            throw new OrderRefundSubmitFailedError(
              err instanceof Error ? err.message : String(err),
            );
          }
          // `applyOrderAutoRefund`'s return type is the general
          // `OrderAutoRefundResult` union (`RefundResult` has no `kind`
          // field at all), even though calling it with
          // paymentMethod IN ('xlm', 'usdc') always resolves to the
          // `OnChainOrderAutoRefundResult` arm at runtime — narrow
          // explicitly rather than assume.
          if ('kind' in outcome && outcome.kind === 'onchain_refund') {
            onChain = { txHash: outcome.refund.txHash };
          }
        } else {
          // 'credit' — the only remaining payment method (loop_asset
          // already rejected above).
          refundMethod = 'mirror_credit';
          const applied = await applyAdminRefund({
            userId: order.userId,
            currency: order.chargeCurrency,
            amountMinor: order.chargeMinor,
            orderId: order.id,
            adminUserId: actor.id,
            reason: auditReason,
          });
          mirrorCredit = { newBalanceMinor: applied.newBalanceMinor.toString() };
        }

        const finalOrder = await getOrderById(order.id);
        const result: AdminOrderRefundResult = {
          orderId: order.id,
          paymentMethod: order.paymentMethod as AdminOrderRefundResult['paymentMethod'],
          refundMethod,
          amountMinor: order.chargeMinor.toString(),
          currency: order.chargeCurrency,
          orderState: finalOrder?.state ?? order.state,
          attested,
          onChain,
          mirrorCredit,
        };
        log.warn(
          { orderId: order.id, adminUserId: actor.id, refundMethod, attested },
          'Admin order refund applied',
        );
        const envelope: AdminAuditEnvelope<AdminOrderRefundResult> = buildAuditEnvelope({
          result,
          actor,
          idempotencyKey,
          appliedAt: new Date(),
          replayed: false,
        });
        return { status: 200, body: envelope as unknown as Record<string, unknown> };
      },
    );
  } catch (err) {
    if (err instanceof OrderRefundNotApplicableError) {
      if (err.kind === 'order_not_found') {
        return c.json({ code: 'NOT_FOUND', message: 'Order not found' }, 404);
      }
      if (err.kind === 'attestation_required') {
        return c.json(
          {
            code: 'ORDER_REFUND_ATTESTATION_REQUIRED',
            message:
              'This order is fulfilled — the customer may already have used the delivered code. Refunding it requires a code-unused attestation: { codeUnused: true, attestationNote }.',
          },
          400,
        );
      }
      if (err.kind === 'unsupported_payment_method') {
        return c.json(
          {
            code: 'ORDER_REFUND_UNSUPPORTED_PAYMENT_METHOD',
            message:
              'loop_asset order refunds are not supported by this endpoint (matches the R3-2 fail-closed posture) — escalate for a manual money-review refund.',
          },
          409,
        );
      }
      if (err.kind === 'procuring_not_stale') {
        return c.json(
          {
            code: 'ORDER_NOT_REFUNDABLE',
            message:
              'Order is still actively procuring — a worker may be mid-flight paying CTX. Wait for it to fulfil, fail, or age into the recovery sweep (15 min) before refunding.',
          },
          400,
        );
      }
      if (err.kind === 'ctx_already_paid') {
        return c.json(
          {
            code: 'ORDER_REFUND_CTX_ALREADY_PAID',
            message:
              'Order is procuring and Loop has already paid CTX for it — refunding now would double-lose money. Escalate for manual reconcile; a genuinely-stuck row is resolved by the recovery sweep.',
          },
          409,
        );
      }
      if (err.kind === 'state_changed') {
        return c.json(
          {
            code: 'ORDER_NOT_REFUNDABLE',
            message:
              'Order state changed concurrently — refresh and retry with a fresh Idempotency-Key.',
          },
          409,
        );
      }
      // not_refundable — pending_payment / expired / an unknown state.
      return c.json(
        {
          code: 'ORDER_NOT_REFUNDABLE',
          message: `Order is in state '${err.orderState ?? 'unknown'}' — nothing to refund.`,
        },
        400,
      );
    }
    if (err instanceof RefundAlreadyIssuedError) {
      return c.json({ code: 'ORDER_ALREADY_REFUNDED', message: err.message }, 409);
    }
    if (err instanceof RefundOrderInvalidError) {
      // Should not happen — userId/currency/amount are all derived from
      // the order row itself, never admin-supplied — but fail loud
      // rather than silently 500 if this ever fires under a race.
      log.error({ err, orderId, reason: err.reason }, 'A5-4: unexpected refund-order mismatch');
      return c.json({ code: 'INTERNAL_ERROR', message: err.message }, 500);
    }
    if (err instanceof DailyAdjustmentLimitError) {
      return c.json(
        {
          code: 'DAILY_LIMIT_EXCEEDED',
          message: `Daily ${err.currency} refund cap (${err.capMinor} minor) hit — ${err.usedMinor} used today, attempted ${err.attemptedDelta}`,
        },
        429,
      );
    }
    if (err instanceof OrderRefundSubmitFailedError) {
      return c.json(
        { code: 'ORDER_REFUND_SUBMIT_FAILED', message: `Refund submit failed: ${err.message}` },
        502,
      );
    }
    log.error({ err, orderId, adminUserId: actor.id }, 'Admin order refund failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to refund order' }, 500);
  }

  if (guardResult.status === 200) {
    const result = (guardResult.body as { result?: AdminOrderRefundResult }).result;
    notifyAdminAudit({
      actorUserId: actor.id,
      endpoint: `POST /api/admin/orders/${orderId}/refund`,
      ...(result?.amountMinor !== undefined ? { amountMinor: result.amountMinor } : {}),
      ...(result?.currency !== undefined ? { currency: result.currency } : {}),
      // Discord gets the FULL attestation note (1024-char field budget)
      // even though the durable ledger `reason` column truncates to 500
      // — the fact-of-attestation is what's load-bearing there.
      reason:
        result?.attested === true && attestation !== undefined
          ? `${reason} | ATTESTATION (code unused/unusable): ${attestation.attestationNote}`
          : reason,
      idempotencyKey,
      replayed: guardResult.replayed,
    });
  }

  return c.json(guardResult.body, guardResult.status as 200 | 400 | 404 | 409 | 429 | 500 | 502);
}
