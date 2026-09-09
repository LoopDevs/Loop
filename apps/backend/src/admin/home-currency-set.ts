/**
 * Admin home-currency change (ADR 015 deferred § "self-serve
 * home-currency change — currently support-mediated").
 *
 * `POST /api/admin/users/:userId/home-currency` — flips
 * `users.homeCurrency` for a user who is past the self-serve window.
 * The self-serve endpoint (`users/handler.ts`) refuses once the user
 * has placed an order, because pricing history is pinned at order
 * creation and a silent flip would misalign it. This endpoint is the
 * deliberate override for that case, which is why it is admin-tier,
 * step-up-gated, and demands a reason: somebody has decided the
 * misalignment is acceptable and their name is on it.
 *
 * ADR 017 admin-write contract:
 *   1. Actor from `c.get('user')` (the staff gate), never the body.
 *   2. Idempotency-Key required; a repeat replays the snapshot.
 *   3. Reason required (2..500 chars), carried into the Discord audit.
 *   4. Reversibility is another admin write running the same path —
 *      there is deliberately no separate "revert" primitive, because
 *      the audit trail is the reversibility surface.
 *   5. Discord audit fanout AFTER the write, fire-and-forget.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { HOME_CURRENCIES } from '@loop/shared';
import { UUID_RE } from '../uuid.js';
import { db } from '../db/client.js';
import { getUserById, type User } from '../db/users.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  validateIdempotencyKey,
  withIdempotencyGuard,
} from './idempotency.js';

const log = logger.child({ handler: 'admin-home-currency-set' });

const BodySchema = z.object({
  homeCurrency: z.enum(HOME_CURRENCIES),
  reason: z.string().min(2).max(500),
});

export interface HomeCurrencySetResult {
  userId: string;
  priorHomeCurrency: string;
  newHomeCurrency: string;
  updatedAt: string;
}

/** Thrown inside the guard when the target is already on that currency. */
class HomeCurrencyUnchangedError extends Error {
  constructor() {
    super('User is already on that home currency');
    this.name = 'HomeCurrencyUnchangedError';
  }
}

export async function adminHomeCurrencySetHandler(c: Context): Promise<Response> {
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
      { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid body' },
      400,
    );
  }

  const target = await getUserById(userId);
  if (target === null) {
    return c.json({ code: 'USER_NOT_FOUND', message: 'User not found' }, 404);
  }

  let guardResult: Awaited<ReturnType<typeof withIdempotencyGuard>>;
  try {
    guardResult = await withIdempotencyGuard(
      {
        adminUserId: actor.id,
        key: idempotencyKey,
        method: 'POST',
        path: `/api/admin/users/${userId}/home-currency`,
      },
      async () => {
        const updatedAt = new Date();
        // Guarded on the CURRENT value rather than read-then-write, so
        // two admins racing on the same user can't both report having
        // made the change — the loser sees no row back and is told the
        // currency was already what they asked for.
        const updated = await db
          .collection('users')
          .updateOne(
            { id: userId, homeCurrency: { $ne: parsed.data.homeCurrency } },
            { $set: { homeCurrency: parsed.data.homeCurrency, updatedAt } },
          );
        if (updated === null) throw new HomeCurrencyUnchangedError();

        const result: HomeCurrencySetResult = {
          userId,
          priorHomeCurrency: target.homeCurrency,
          newHomeCurrency: parsed.data.homeCurrency,
          updatedAt: updatedAt.toISOString(),
        };
        const envelope: AdminAuditEnvelope<HomeCurrencySetResult> = buildAuditEnvelope({
          result,
          actor,
          idempotencyKey,
          appliedAt: updatedAt,
          replayed: false,
        });
        return { status: 200, body: envelope as unknown as Record<string, unknown> };
      },
    );
  } catch (err) {
    if (err instanceof HomeCurrencyUnchangedError) {
      return c.json(
        {
          code: 'HOME_CURRENCY_UNCHANGED',
          message: 'User is already on that home currency',
        },
        409,
      );
    }
    log.error({ err, userId, adminUserId: actor.id }, 'Admin home-currency change failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to change home currency' }, 500);
  }

  notifyAdminAudit({
    actorUserId: actor.id,
    endpoint: `POST /api/admin/users/${userId}/home-currency`,
    targetUserId: userId,
    reason: `${target.homeCurrency} → ${parsed.data.homeCurrency}: ${parsed.data.reason}`,
    idempotencyKey,
    replayed: guardResult.replayed,
  });

  return c.json(guardResult.body, guardResult.status as 200 | 400 | 404 | 409 | 500);
}
