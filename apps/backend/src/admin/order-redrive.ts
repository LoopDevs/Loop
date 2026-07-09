/**
 * Admin order re-drive lever (A5-1 — readiness-backlog §Tier 5 "the
 * biggest hole").
 *
 * `POST /api/admin/orders/:orderId/redrive` — today a `paid` or
 * `procuring` order with no live worker touching it has NO operator
 * action: no requeue, no manual re-procure, no cancel. Resolution
 * relies on the procurement worker eventually retrying (transient
 * errors already self-heal inside `procureOne`) or, failing that, the
 * 15-minute `sweepStuckProcurement` recovery sweep — which only ever
 * FAILS a stuck row (auto-refund or hold), never retries it. If the
 * whole worker process is down (crashed machine, `LOOP_WORKERS_ENABLED`
 * off), neither the tick nor the sweep run at all and an operator's
 * only lever today is raw SQL or a kill switch.
 *
 * This handler re-runs the SAME procurement path the worker itself
 * uses (`procureOne` from `orders/procure-one.ts`) rather than any
 * parallel money logic, so every existing safety property still
 * holds:
 *
 *   - `markOrderProcuring`'s `WHERE state='paid'` CAS makes
 *     `procureOne` a no-op ('skipped') if anything else already
 *     claimed the order — a redrive of a `paid` order that a live
 *     worker ticks into `procuring` a moment earlier just loses the
 *     race harmlessly.
 *   - `payCtxOrder`'s `ctx_settlements` durable record + authoritative
 *     Horizon hash lookup (hardening A4) makes the CTX payment
 *     idempotent across re-runs (INV-7) — a redrive can never cause
 *     Loop to pay CTX twice for the same order.
 *
 * `paid` orders are always safe to redrive directly — the CAS above
 * is the only guard needed. `procuring` orders are trickier: nothing
 * in this codebase distinguishes "the worker crashed mid-flight" from
 * "the worker is still legitimately working this order" (CTX call +
 * up to ~5 minutes waiting on the redemption SSE stream). Forcing a
 * `procuring` order back to `paid` while a live worker is still
 * holding it would let a SECOND `procureOne` run concurrently against
 * the same order — outside the single-flighted-by-CAS model
 * `payCtxOrder`'s idempotency assumes, and a real (if narrow) double
 * -pay-CTX risk (see the money-review notes in the PR). So a
 * `procuring` redrive is gated on the SAME staleness bar the
 * automatic stuck-procurement sweep already uses
 * (`PROCUREMENT_TIMEOUT_MS`, 15 minutes) — reusing the established,
 * already-reviewed "no legitimate worker is still running this" bar
 * rather than inventing a shorter one — AND refuses the redrive
 * outright (409) when the durable settlement record shows Loop
 * already paid CTX for this order (reusing `loopPaidCtx`, the same
 * disambiguation the sweep uses): redriving that case would just have
 * `procureOne` create a confusing, wasteful second CTX order (refused
 * downstream by the `ctx_settlements` reconcile guard, so it still
 * can't double-pay, but there's no reason to let an operator walk
 * into it).
 *
 * Cancel-and-refund of a genuinely stuck order is deliberately OUT of
 * scope here — that's A5-4 (order-bound refund UI + fulfilled-order
 * policy), a distinct decision with its own policy questions. This
 * endpoint is the re-drive/retry lever only.
 *
 * ADR 017 envelope (Idempotency-Key + reason + Discord audit) plus
 * ADR 028 step-up (`'order-redrive'` scope, admin-tier only) — unlike
 * the ADR 037 support-tier delivery-unsticking actions, a re-drive
 * can submit a real outbound Stellar payment to CTX, so it's a money
 * write, not a read-unsticking one.
 */
import type { Context } from 'hono';
import type { AdminOrderRedriveResult } from '@loop/shared';
import { UUID_RE } from '../uuid.js';
import type { User } from '../db/users.js';
import { getOrderById } from '../orders/repo.js';
import { procureOne } from '../orders/procure-one.js';
import { revertOrderProcuringToPaid } from '../orders/transitions.js';
import { loopPaidCtx } from '../orders/transitions-sweeps.js';
import { PROCUREMENT_TIMEOUT_MS } from '../orders/procurement-worker.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  validateIdempotencyKey,
  withIdempotencyGuard,
} from './idempotency.js';

const log = logger.child({ handler: 'admin-order-redrive' });

/** Non-terminal states eligible for a redrive. Terminal/pre-payment states are refused. */
const REDRIVABLE_STATES = new Set(['paid', 'procuring']);

/**
 * Control-flow escape for the not-applicable outcomes — thrown from
 * inside the idempotency guard so no failure snapshot is stored (a
 * transient-state 409 must never replay once the order's real state
 * has moved on).
 */
class RedriveNotApplicableError extends Error {
  constructor(
    readonly kind:
      | 'order_not_found'
      | 'not_redrivable'
      | 'not_stale_enough'
      | 'ctx_already_paid'
      | 'state_changed',
    readonly orderState?: string,
  ) {
    super(`order redrive not applicable: ${kind}`);
    this.name = 'RedriveNotApplicableError';
  }
}

export async function adminRedriveOrderHandler(c: Context): Promise<Response> {
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
  const reason =
    body !== null && typeof body === 'object' ? (body as Record<string, unknown>)['reason'] : null;
  if (typeof reason !== 'string' || reason.length < 2 || reason.length > 500) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'reason must be 2-500 chars' }, 400);
  }

  let guardResult: Awaited<ReturnType<typeof withIdempotencyGuard>>;
  try {
    guardResult = await withIdempotencyGuard(
      {
        adminUserId: actor.id,
        key: idempotencyKey,
        method: 'POST',
        path: `/api/admin/orders/${orderId}/redrive`,
      },
      async () => {
        const order = await getOrderById(orderId);
        if (order === null) {
          throw new RedriveNotApplicableError('order_not_found');
        }
        if (!REDRIVABLE_STATES.has(order.state)) {
          throw new RedriveNotApplicableError('not_redrivable', order.state);
        }

        let workingOrder = order;
        if (order.state === 'procuring') {
          // Only ever revert a `procuring` row back to `paid` once it's
          // past the SAME staleness bar the automatic stuck-procurement
          // sweep uses — see the module docstring for why a shorter bar
          // would risk racing a still-live worker.
          const stale =
            order.procuredAt !== null &&
            Date.now() - order.procuredAt.getTime() >= PROCUREMENT_TIMEOUT_MS;
          if (!stale) {
            throw new RedriveNotApplicableError('not_stale_enough');
          }
          const ctxPaid = await loopPaidCtx(order.id);
          if (ctxPaid) {
            throw new RedriveNotApplicableError('ctx_already_paid');
          }
          const reverted = await revertOrderProcuringToPaid(order.id);
          if (reverted === null) {
            // Lost the race — something else (the sweep, another
            // redrive) already moved the row off `procuring`.
            throw new RedriveNotApplicableError('state_changed');
          }
          workingOrder = reverted;
        }

        // `workingOrder.state === 'paid'` here. `procureOne` owns its
        // own `markOrderProcuring` CAS claim — this call cannot
        // double-claim or double-pay regardless of what else is
        // racing it (see module docstring).
        const outcome = await procureOne(workingOrder);

        const finalOrder = await getOrderById(orderId);
        const result: AdminOrderRedriveResult = {
          orderId,
          outcome,
          state: finalOrder?.state ?? workingOrder.state,
        };
        log.info(
          { orderId, adminUserId: actor.id, outcome, finalState: result.state },
          'Admin order redrive applied',
        );
        const envelope: AdminAuditEnvelope<AdminOrderRedriveResult> = buildAuditEnvelope({
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
    if (err instanceof RedriveNotApplicableError) {
      if (err.kind === 'order_not_found') {
        return c.json({ code: 'NOT_FOUND', message: 'Order not found' }, 404);
      }
      if (err.kind === 'not_redrivable') {
        return c.json(
          {
            code: 'ORDER_NOT_REDRIVABLE',
            message: `Order is in state '${err.orderState ?? 'unknown'}' — only 'paid' and 'procuring' orders can be redriven`,
          },
          400,
        );
      }
      if (err.kind === 'not_stale_enough') {
        return c.json(
          {
            code: 'ORDER_REDRIVE_NOT_STALE',
            message:
              'Order has been procuring for less than the stuck-procurement threshold — a worker may still be actively processing it. Wait, or use the stuck-orders view to confirm before retrying.',
          },
          409,
        );
      }
      if (err.kind === 'ctx_already_paid') {
        return c.json(
          {
            code: 'ORDER_REDRIVE_CTX_ALREADY_PAID',
            message:
              'Loop already paid CTX for this order — redriving would create a second CTX gift-card order. Use the redemption re-fetch action or escalate for manual reconcile instead.',
          },
          409,
        );
      }
      // state_changed
      return c.json(
        {
          code: 'ORDER_REDRIVE_STATE_CHANGED',
          message: 'Order state changed before the redrive could apply — refresh and retry.',
        },
        409,
      );
    }
    log.error({ err, orderId, actorUserId: actor.id }, 'Admin order redrive failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to redrive order' }, 500);
  }

  if (guardResult.status === 200) {
    notifyAdminAudit({
      actorUserId: actor.id,
      endpoint: `POST /api/admin/orders/${orderId}/redrive`,
      reason,
      idempotencyKey,
      replayed: guardResult.replayed,
    });
  }

  return c.json(guardResult.body, guardResult.status as 200 | 400 | 404 | 409 | 500);
}
