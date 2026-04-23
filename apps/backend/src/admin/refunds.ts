/**
 * Admin refund endpoint (ADR 017 + A2-901).
 *
 * `POST /api/admin/users/:userId/refunds` — issues a positive-amount
 * `credit_transactions` row of `type='refund'` bound to an order.
 * The write is idempotent in two layers:
 *
 *   - Admin idempotency key (ADR 017) — the usual actor+key snapshot
 *     replay, covers the "support agent double-clicked submit" case.
 *   - DB partial unique index on (type, reference_type, reference_id)
 *     from migration 0013 — catches the "two admins both issued a
 *     refund for the same order" race. Surfaces as 409
 *     REFUND_ALREADY_ISSUED.
 *
 * Response envelope matches the credit-adjustments handler so the
 * admin UI can share the post-action renderer.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { HOME_CURRENCIES } from '../db/schema.js';
import type { User } from '../db/users.js';
import { applyAdminRefund, RefundAlreadyIssuedError } from '../credits/refunds.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  lookupIdempotencyKey,
  storeIdempotencyKey,
  validateIdempotencyKey,
} from './idempotency.js';

const log = logger.child({ handler: 'admin-refund' });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `amountMinor` is an unsigned integer-as-string. Refunds are always
 * positive — the schema CHECK rejects zero or negative for this
 * type. Cap at 10,000,000 minor units (£100k / $100k) same as the
 * adjustment handler — refunds above that should go through a
 * separate review process.
 */
const BodySchema = z.object({
  amountMinor: z
    .string()
    .regex(/^\d+$/, 'amountMinor must be a positive integer string')
    .refine((s) => {
      try {
        const n = BigInt(s);
        return n > 0n && n <= 10_000_000n;
      } catch {
        return false;
      }
    }, 'amountMinor must be positive and within 10_000_000 minor units'),
  currency: z.enum(HOME_CURRENCIES),
  orderId: z.string().regex(UUID_RE, 'orderId must be a uuid'),
  reason: z.string().min(2).max(500),
});

export interface RefundResponse {
  id: string;
  userId: string;
  currency: string;
  amountMinor: string;
  orderId: string;
  priorBalanceMinor: string;
  newBalanceMinor: string;
  createdAt: string;
}

export async function adminRefundHandler(c: Context): Promise<Response> {
  const userId = c.req.param('userId');
  if (userId === undefined || !UUID_RE.test(userId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a uuid' }, 400);
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
      {
        code: 'VALIDATION_ERROR',
        message: parsed.error.issues[0]?.message ?? 'Invalid body',
      },
      400,
    );
  }

  // Replay path — return stored snapshot verbatim with replayed:true.
  const prior = await lookupIdempotencyKey({
    adminUserId: actor.id,
    key: idempotencyKey,
  });
  if (prior !== null) {
    const priorResult = (prior.body as { result?: RefundResponse }).result;
    notifyAdminAudit({
      actorUserId: actor.id,
      actorEmail: actor.email,
      endpoint: `POST /api/admin/users/${userId}/refunds`,
      targetUserId: userId,
      ...(priorResult?.amountMinor !== undefined ? { amountMinor: priorResult.amountMinor } : {}),
      ...(priorResult?.currency !== undefined ? { currency: priorResult.currency } : {}),
      reason: parsed.data.reason,
      idempotencyKey,
      replayed: true,
    });
    return c.json(prior.body, prior.status as 200 | 400 | 409 | 500);
  }

  const amountMinor = BigInt(parsed.data.amountMinor);
  let applied;
  try {
    applied = await applyAdminRefund({
      userId,
      currency: parsed.data.currency,
      amountMinor,
      orderId: parsed.data.orderId,
      adminUserId: actor.id,
    });
  } catch (err) {
    if (err instanceof RefundAlreadyIssuedError) {
      return c.json(
        {
          code: 'REFUND_ALREADY_ISSUED',
          message: err.message,
        },
        409,
      );
    }
    log.error({ err, userId, adminUserId: actor.id }, 'Refund failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to apply refund' }, 500);
  }

  const result: RefundResponse = {
    id: applied.id,
    userId: applied.userId,
    currency: applied.currency,
    amountMinor: applied.amountMinor.toString(),
    orderId: applied.orderId,
    priorBalanceMinor: applied.priorBalanceMinor.toString(),
    newBalanceMinor: applied.newBalanceMinor.toString(),
    createdAt: applied.createdAt.toISOString(),
  };

  const envelope: AdminAuditEnvelope<RefundResponse> = buildAuditEnvelope({
    result,
    actor,
    idempotencyKey,
    appliedAt: applied.createdAt,
    replayed: false,
  });

  try {
    await storeIdempotencyKey({
      adminUserId: actor.id,
      key: idempotencyKey,
      method: 'POST',
      path: `/api/admin/users/${userId}/refunds`,
      status: 200,
      body: envelope as unknown as Record<string, unknown>,
    });
  } catch (err) {
    log.warn(
      { err, adminUserId: actor.id, key: idempotencyKey },
      'Failed to persist idempotency snapshot; retry will replay as new write',
    );
  }

  notifyAdminAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    endpoint: `POST /api/admin/users/${userId}/refunds`,
    targetUserId: userId,
    amountMinor: result.amountMinor,
    currency: result.currency,
    reason: parsed.data.reason,
    idempotencyKey,
    replayed: false,
  });

  return c.json(envelope, 200);
}
