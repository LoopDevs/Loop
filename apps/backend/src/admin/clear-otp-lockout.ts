// POST /api/admin/users/:userId/clear-otp-lockout — A5-3
import type { Context } from 'hono';
import { z } from 'zod';
import type { AdminClearOtpLockoutResult } from '@loop/shared';
import { UUID_RE } from '../uuid.js';
import { db } from '../db/client.js';
import { withKeyedLock } from '../db/keyed-lock.js';
import { getUserById, type User } from '../db/users.js';
import { clearOtpAttempts } from '../auth/otp-attempt-counter.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  IDEMPOTENCY_TTL_HOURS,
  countAppliedActionsForPath,
  validateIdempotencyKey,
  withIdempotencyGuard,
} from './idempotency.js';

const log = logger.child({ handler: 'admin-clear-otp-lockout' });

// Per-target cap: 5 clears/24h. Tight enough to bound the clear→guess loop, generous for legitimate recovery.
export const CLEAR_LOCKOUT_MAX_PER_TARGET_PER_DAY = 5;

// Window pinned to idempotency TTL: rows are only guaranteed readable-as-replays for that long.
export const CLEAR_LOCKOUT_WINDOW_MS = IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000;

/** Thrown inside the guard when the per-target cap is hit → 429, no snapshot stored. */
class ClearLockoutRateExceededError extends Error {
  constructor() {
    super('Per-target clear-lockout cap exceeded');
    this.name = 'ClearLockoutRateExceededError';
  }
}

const BodySchema = z.object({
  reason: z.string().min(2).max(500),
});

export async function adminClearOtpLockoutHandler(c: Context): Promise<Response> {
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

  const path = `/api/admin/users/${userId}/clear-otp-lockout`;

  let guardResult: Awaited<ReturnType<typeof withIdempotencyGuard>>;
  try {
    // Per-target lock wraps the guard: the cap is about one victim, the guard only serialises one (admin, key) pair.
    guardResult = await withKeyedLock(`clear-otp-lockout:${userId}`, async () =>
      withIdempotencyGuard(
        { adminUserId: actor.id, key: idempotencyKey, method: 'POST', path },
        async () => {
          // Fail-closed: a throw here rejects the action rather than handing the caller a free, uncounted clear.
          const applied = await countAppliedActionsForPath({
            path,
            windowMs: CLEAR_LOCKOUT_WINDOW_MS,
          });
          if (applied >= CLEAR_LOCKOUT_MAX_PER_TARGET_PER_DAY) {
            throw new ClearLockoutRateExceededError();
          }

          const counter = await db.collection('otp_attempt_counters').findOne({
            email: target.email,
          });
          const wasLocked =
            counter?.lockedUntil !== null &&
            counter?.lockedUntil !== undefined &&
            counter.lockedUntil.getTime() > Date.now();

          await clearOtpAttempts(target.email);

          const appliedAt = new Date();
          const result: AdminClearOtpLockoutResult = { userId, wasLocked, cleared: true };
          const envelope: AdminAuditEnvelope<AdminClearOtpLockoutResult> = buildAuditEnvelope({
            result,
            actor,
            idempotencyKey,
            appliedAt,
            replayed: false,
          });
          return { status: 200, body: envelope as unknown as Record<string, unknown> };
        },
      ),
    );
  } catch (err) {
    if (err instanceof ClearLockoutRateExceededError) {
      return c.json(
        {
          code: 'CLEAR_LOCKOUT_RATE_EXCEEDED',
          message: `This account has already had ${CLEAR_LOCKOUT_MAX_PER_TARGET_PER_DAY} lockout clears in the last 24 hours. Escalate rather than clearing again.`,
        },
        429,
      );
    }
    log.error({ err, userId, adminUserId: actor.id }, 'Clear-otp-lockout failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to clear the lockout' }, 500);
  }

  notifyAdminAudit({
    actorUserId: actor.id,
    endpoint: `POST ${path}`,
    targetUserId: userId,
    reason: parsed.data.reason,
    idempotencyKey,
    replayed: guardResult.replayed,
  });

  return c.json(guardResult.body, guardResult.status as 200 | 400 | 404 | 429 | 500);
}
