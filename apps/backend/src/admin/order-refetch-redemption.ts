/**
 * One-shot redemption re-fetch (ADR 037 §4.3 delivery-unsticking).
 *
 * `POST /api/admin/orders/:orderId/refetch-redemption` — support
 * action for the "fulfilled but redemption fields all NULL" state
 * (runbook: docs/runbooks/redemption-backfill-exhausted.md). Drives
 * the SAME machinery as the backfill sweeper
 * (`refetchOrderRedemption` in orders/redemption-backfill.ts) — one
 * `fetchRedemption` through the operator pool, the idempotent
 * persist guards, the attempts bookkeeping — with no backoff gate
 * and no attempts cap, because the action exists precisely for
 * exhausted rows.
 *
 * The result reports field PRESENCE only (`hasCode` / `hasPin` /
 * `hasUrl`) — the actual codes are gift-card money and are never
 * echoed into the envelope / idempotency snapshot / Discord audit.
 *
 * ADR 017 envelope discipline applies even though no money moves
 * (uniform audit trail). The CTX fetch runs inside the idempotency
 * guard — acceptable for a rare, 10/min-limited, human-clicked
 * action; the underlying writes are race-safe on their own WHERE
 * guards.
 */
import type { Context } from 'hono';
import type { AdminRefetchRedemptionResult } from '@loop/shared';
import { UUID_RE } from '../uuid.js';
import type { User } from '../db/users.js';
import { refetchOrderRedemption } from '../orders/redemption-backfill.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  validateIdempotencyKey,
  withIdempotencyGuard,
} from './idempotency.js';

const log = logger.child({ handler: 'admin-refetch-redemption' });

/**
 * Control-flow escape for the not-applicable outcomes — thrown from
 * inside the idempotency guard so no failure snapshot is stored
 * (a 503 must never replay after CTX recovers).
 */
class RefetchNotApplicableError extends Error {
  constructor(
    readonly kind: 'order_not_found' | 'not_eligible' | 'pool_unavailable',
    readonly reason?: string,
  ) {
    super(`refetch not applicable: ${kind}`);
    this.name = 'RefetchNotApplicableError';
  }
}

const NOT_ELIGIBLE_MESSAGES: Record<string, string> = {
  not_fulfilled: 'Order is not fulfilled — redemption re-fetch only applies to fulfilled orders',
  no_ctx_order_id: 'Order has no CTX order id — nothing to re-fetch against',
  already_present: 'Order already has a redemption payload — nothing to re-fetch',
};

export async function adminRefetchRedemptionHandler(c: Context): Promise<Response> {
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
    return c.json({ code: 'UNAUTHORIZED', message: 'Staff context missing' }, 401);
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
        path: `/api/admin/orders/${orderId}/refetch-redemption`,
      },
      async () => {
        const outcome = await refetchOrderRedemption(orderId);
        if (outcome.kind !== 'recovered' && outcome.kind !== 'still_empty') {
          // Throwing escapes the guard WITHOUT storing a snapshot —
          // a retry with the same key after the order/pool state
          // changes must re-evaluate, not replay a stale failure.
          throw new RefetchNotApplicableError(
            outcome.kind,
            outcome.kind === 'not_eligible' ? outcome.reason : undefined,
          );
        }
        const result: AdminRefetchRedemptionResult = {
          orderId,
          recovered: outcome.kind === 'recovered',
          hasCode: outcome.hasCode,
          hasPin: outcome.hasPin,
          hasUrl: outcome.hasUrl,
          attempts: outcome.attempts,
        };
        const envelope: AdminAuditEnvelope<AdminRefetchRedemptionResult> = buildAuditEnvelope({
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
    if (err instanceof RefetchNotApplicableError) {
      if (err.kind === 'order_not_found') {
        return c.json({ code: 'NOT_FOUND', message: 'Order not found' }, 404);
      }
      if (err.kind === 'pool_unavailable') {
        return c.json(
          {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Operator pool unavailable — retry once CTX recovers',
          },
          503,
        );
      }
      return c.json(
        {
          code: 'REDEMPTION_NOT_REFETCHABLE',
          message: NOT_ELIGIBLE_MESSAGES[err.reason ?? ''] ?? 'Order is not eligible',
        },
        409,
      );
    }
    log.error({ err, orderId, actorUserId: actor.id }, 'Redemption re-fetch failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to re-fetch redemption' }, 500);
  }

  if (guardResult.status === 200) {
    notifyAdminAudit({
      actorUserId: actor.id,
      endpoint: `POST /api/admin/orders/${orderId}/refetch-redemption`,
      reason,
      idempotencyKey,
      replayed: guardResult.replayed,
    });
  }

  return c.json(guardResult.body, guardResult.status as 200 | 404 | 409 | 500 | 503);
}
