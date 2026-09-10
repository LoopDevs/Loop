// per-order operator actions — ADR 037, ADR 017
import type { Context } from 'hono';
import { z } from 'zod';
import type { AdminRefetchRedemptionResult } from '@loop/shared';
import { UUID_RE } from '../uuid.js';
import type { User } from '../db/users.js';
import { refetchOrderRedemption } from '../orders/redemption-backfill.js';
import { resyncOrderFromCtx } from '../orders/ctx-mirror-sweep.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  validateIdempotencyKey,
  withIdempotencyGuard,
} from './idempotency.js';

const log = logger.child({ handler: 'admin-order-actions' });

const BodySchema = z.object({
  reason: z.string().min(2).max(500),
});

interface WriteEdge {
  orderId: string;
  idempotencyKey: string;
  actor: User;
  reason: string;
}

async function validateWriteEdge(c: Context): Promise<Response | WriteEdge> {
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
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid body' },
      400,
    );
  }
  return { orderId, idempotencyKey, actor, reason: parsed.data.reason };
}

export async function adminRefetchRedemptionHandler(c: Context): Promise<Response> {
  const edge = await validateWriteEdge(c);
  if (edge instanceof Response) return edge;
  const { orderId, idempotencyKey, actor, reason } = edge;

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
        switch (outcome.kind) {
          case 'order_not_found':
            return {
              status: 404,
              body: { code: 'NOT_FOUND', message: 'Order not found' },
            };
          case 'not_eligible':
            return {
              status: 409,
              body: {
                code: 'REFETCH_NOT_ELIGIBLE',
                message: `Order is not eligible for a redemption re-fetch (${outcome.reason})`,
              },
            };
          case 'ctx_unavailable':
            return {
              status: 503,
              body: {
                code: 'CTX_UNAVAILABLE',
                message: 'CTX is unavailable — the backfill worker will retry on its own cadence',
              },
            };
          case 'recovered':
          case 'still_empty': {
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
          }
        }
      },
    );
  } catch (err) {
    log.error({ err, orderId, adminUserId: actor.id }, 'Admin redemption re-fetch failed');
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

export interface AdminOrderRedriveResult {
  orderId: string;
  state: string;
}

export async function adminOrderRedriveHandler(c: Context): Promise<Response> {
  const edge = await validateWriteEdge(c);
  if (edge instanceof Response) return edge;
  const { orderId, idempotencyKey, actor, reason } = edge;

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
        const outcome = await resyncOrderFromCtx(orderId);
        switch (outcome.kind) {
          case 'order_not_found':
            return { status: 404, body: { code: 'NOT_FOUND', message: 'Order not found' } };
          case 'not_eligible':
            return {
              status: 409,
              body: {
                code: 'REDRIVE_NOT_ELIGIBLE',
                message:
                  'Order is in a terminal state — there is nothing left for CTX to report on it',
              },
            };
          case 'resynced': {
            const result: AdminOrderRedriveResult = { orderId, state: outcome.state };
            const envelope: AdminAuditEnvelope<AdminOrderRedriveResult> = buildAuditEnvelope({
              result,
              actor,
              idempotencyKey,
              appliedAt: new Date(),
              replayed: false,
            });
            return { status: 200, body: envelope as unknown as Record<string, unknown> };
          }
        }
      },
    );
  } catch (err) {
    log.error({ err, orderId, adminUserId: actor.id }, 'Admin order redrive failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to re-drive the order' }, 500);
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

  return c.json(guardResult.body, guardResult.status as 200 | 404 | 409 | 500);
}
