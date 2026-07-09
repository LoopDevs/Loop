/**
 * Admin order re-drive lever (A5-1 — readiness-backlog §Tier 5 "the
 * biggest hole").
 *
 * `POST /api/admin/orders/:orderId/redrive` — a `paid` order the
 * procurement worker never drains has NO operator action today and NO
 * automatic recovery: `runProcurementTick` only picks it up while a
 * worker process is alive, and the 15-minute `sweepStuckProcurement`
 * recovery sweep only ever touches `procuring` rows — it never looks
 * at `paid`. So a `paid` order stranded because the worker is down
 * (crashed machine, `LOOP_WORKERS_ENABLED` off, an operator-pool
 * outage that outlived the tick) sits forever, and an operator's only
 * lever is raw SQL or a kill switch. This is the gap A5-1 closes.
 *
 * This handler re-runs the SAME procurement path the worker itself
 * uses (`procureOne` from `orders/procure-one.ts`) rather than any
 * parallel money logic, so every existing safety property holds:
 *
 *   - `markOrderProcuring`'s `WHERE state='paid'` CAS is a hard
 *     single-flight gate. Whatever else is racing this order — a live
 *     worker tick, the background sweep, a second concurrent redrive —
 *     exactly ONE caller wins the transition into `procuring`; every
 *     other `procureOne` gets `null` back and returns `'skipped'`
 *     before it ever reaches `payCtxOrder`. So a redrive can never
 *     produce a second in-flight procurement (and therefore never a
 *     second `payCtxOrder`) for the same order.
 *   - Because only one `procureOne` per order can reach `payCtxOrder`,
 *     `payCtxOrder`'s `ctx_settlements` durable record + authoritative
 *     Horizon hash lookup (hardening A4, INV-7) sees the same
 *     single-flight it was designed for — a redrive can never cause
 *     Loop to pay CTX twice.
 *
 * SCOPE — `paid` orders ONLY (money-review 2026-07-09, PR #1609).
 * `procuring` orders are deliberately refused (409
 * `ORDER_REDRIVE_IN_PROGRESS`). A manual re-procure of a `procuring`
 * order would mean forcibly reverting it to `paid` and calling
 * `procureOne` again — but nothing in the codebase distinguishes "the
 * worker crashed mid-flight" from "the worker is still legitimately
 * working this order" (a CTX call + up to ~5 min waiting on the
 * redemption stream, and `submitNativePayment`'s `loadAccount` has no
 * client-side timeout, so a hung-but-alive worker can outlast any
 * wall-clock staleness bar). Reverting under a genuinely-live worker
 * would spawn a SECOND, independent claim episode outside the
 * single-flight model above — the money review found this can strand a
 * paid, CTX-paid order in `failed` with no refund (INV-6) and, in a
 * narrower window, double-pay CTX (INV-7). That path is NOT worth the
 * risk here: stuck `procuring` orders already have the automatic
 * recovery sweep (fail + auto-refund when CTX is unpaid, hold + page
 * ops when it is), so they are not left with "no action" the way a
 * stuck `paid` order is. Making `procuring` safely re-procurable needs
 * a genuine liveness signal + bounded Horizon I/O — core-payment-path
 * hardening tracked as a follow-up, out of scope for the re-drive
 * lever.
 *
 * Cancel-and-refund of a genuinely stuck order is also OUT of scope —
 * that's A5-4 (order-bound refund UI + fulfilled-order policy), a
 * distinct decision with its own policy questions. This endpoint is
 * the re-drive/retry lever only.
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

/**
 * Control-flow escape for the not-applicable outcomes — thrown from
 * inside the idempotency guard so no failure snapshot is stored (a
 * transient-state 409/400 must never replay once the order's real
 * state has moved on).
 */
class RedriveNotApplicableError extends Error {
  constructor(
    readonly kind: 'order_not_found' | 'in_progress' | 'not_redrivable',
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
        // `procuring` is refused (not re-procured) — see the SCOPE
        // section of the module docstring. It's distinguished from the
        // terminal/pre-payment refusal so the operator gets the "wait
        // for the recovery sweep" guidance rather than "dead order".
        if (order.state === 'procuring') {
          throw new RedriveNotApplicableError('in_progress');
        }
        if (order.state !== 'paid') {
          throw new RedriveNotApplicableError('not_redrivable', order.state);
        }

        // state === 'paid'. `procureOne` owns its own
        // `markOrderProcuring` CAS claim — this call cannot double-claim
        // or double-pay regardless of what else (a live worker tick,
        // another redrive) is racing it: exactly one caller wins the
        // `WHERE state='paid'` transition, the rest return 'skipped'
        // before reaching payCtxOrder (see module docstring).
        const outcome = await procureOne(order);

        const finalOrder = await getOrderById(orderId);
        const result: AdminOrderRedriveResult = {
          orderId,
          outcome,
          state: finalOrder?.state ?? order.state,
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
      if (err.kind === 'in_progress') {
        return c.json(
          {
            code: 'ORDER_REDRIVE_IN_PROGRESS',
            message:
              'Order is currently procuring. A stuck procuring order is auto-recovered by the recovery sweep (failed + refunded when CTX is unpaid, held + paged when it is) — the re-drive lever is for paid orders the worker has not picked up. Do not force-retry a procuring order.',
          },
          409,
        );
      }
      // not_redrivable — terminal / pre-payment state
      return c.json(
        {
          code: 'ORDER_NOT_REDRIVABLE',
          message: `Order is in state '${err.orderState ?? 'unknown'}' — only a 'paid' order can be redriven`,
        },
        400,
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
