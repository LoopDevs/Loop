/**
 * Admin credit-adjustment endpoint (ADR 017).
 *
 * `POST /api/admin/users/:userId/credit-adjustments` — writes a
 * signed `credit_transactions` row (`type='adjustment'`) and
 * atomically bumps `user_credits.balance_minor`. First endpoint to
 * use every ADR-017 primitive:
 *   1. Actor from `c.get('user')` (admin middleware), never body.
 *   2. Idempotency-Key required; repeat → snapshot replay.
 *   3. Reason required (2..500 chars), persisted in Discord + snap.
 *   4. Reversibility — append-only; a correction is a second row.
 *   5. Discord audit fanout AFTER commit, fire-and-forget.
 *
 * Response envelope: `{ result, audit }` per ADR 017.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { HOME_CURRENCIES } from '../db/schema.js';
import type { User } from '../db/users.js';
import { applyAdminCreditAdjustment, InsufficientBalanceError } from '../credits/adjustments.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  validateIdempotencyKey,
  withIdempotencyGuard,
} from './idempotency.js';

const log = logger.child({ handler: 'admin-credit-adjustment' });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Body shape. `amountMinor` is a signed integer-as-string to survive
 * JSON round-trips without precision loss. Magnitude cap is 100k
 * major units (10_000_000 minor) — anything larger should go through
 * a separate process, not a single admin click.
 */
const BodySchema = z.object({
  amountMinor: z
    .string()
    .regex(/^-?\d+$/, 'amountMinor must be an integer string')
    .refine((s) => {
      try {
        const n = BigInt(s);
        return n !== 0n && n >= -10_000_000n && n <= 10_000_000n;
      } catch {
        return false;
      }
    }, 'amountMinor must be non-zero and within ±10_000_000 minor units'),
  currency: z.enum(HOME_CURRENCIES),
  reason: z.string().min(2).max(500),
});

export interface CreditAdjustmentResult {
  id: string;
  userId: string;
  currency: string;
  amountMinor: string;
  priorBalanceMinor: string;
  newBalanceMinor: string;
  createdAt: string;
}

export async function adminCreditAdjustmentHandler(c: Context): Promise<Response> {
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
    // requireAdmin should have populated this. Fail closed rather
    // than silently attributing the write to an unknown actor.
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

  // A2-2001: serialise lookup → write → store under an advisory
  // lock keyed by (actor, idempotencyKey). Two concurrent requests
  // with the same key block on the lock; the second sees the stored
  // snapshot on re-lookup and replays. Before this, both could pass
  // the lookup, both call applyAdminCreditAdjustment, and both
  // double-credit the user.
  const amountMinor = BigInt(parsed.data.amountMinor);
  let guardResult;
  try {
    guardResult = await withIdempotencyGuard(
      {
        adminUserId: actor.id,
        key: idempotencyKey,
        method: 'POST',
        path: `/api/admin/users/${userId}/credit-adjustments`,
      },
      async () => {
        const applied = await applyAdminCreditAdjustment({
          userId,
          currency: parsed.data.currency,
          amountMinor,
          adminUserId: actor.id,
          reason: parsed.data.reason,
        });
        const result: CreditAdjustmentResult = {
          id: applied.id,
          userId: applied.userId,
          currency: applied.currency,
          amountMinor: applied.amountMinor.toString(),
          priorBalanceMinor: applied.priorBalanceMinor.toString(),
          newBalanceMinor: applied.newBalanceMinor.toString(),
          createdAt: applied.createdAt.toISOString(),
        };
        const envelope: AdminAuditEnvelope<CreditAdjustmentResult> = buildAuditEnvelope({
          result,
          actor,
          idempotencyKey,
          appliedAt: applied.createdAt,
          replayed: false,
        });
        return { status: 200, body: envelope as unknown as Record<string, unknown> };
      },
    );
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      return c.json(
        {
          code: 'INSUFFICIENT_BALANCE',
          message: `Debit of ${amountMinor} would drive ${err.currency} balance below zero (current: ${err.balanceMinor})`,
        },
        409,
      );
    }
    log.error({ err, userId, adminUserId: actor.id }, 'Credit adjustment failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to apply adjustment' }, 500);
  }

  // Discord fanout — fire-and-forget AFTER commit per ADR 017 #5.
  // Runs for both fresh writes and replays so ops sees "this was
  // already processed" in the channel.
  const priorResult = (guardResult.body as { result?: CreditAdjustmentResult }).result;
  notifyAdminAudit({
    actorUserId: actor.id,
    endpoint: `POST /api/admin/users/${userId}/credit-adjustments`,
    targetUserId: userId,
    ...(priorResult?.amountMinor !== undefined ? { amountMinor: priorResult.amountMinor } : {}),
    ...(priorResult?.currency !== undefined ? { currency: priorResult.currency } : {}),
    reason: parsed.data.reason,
    idempotencyKey,
    replayed: guardResult.replayed,
  });

  return c.json(guardResult.body, guardResult.status as 200 | 400 | 409 | 500);
}
