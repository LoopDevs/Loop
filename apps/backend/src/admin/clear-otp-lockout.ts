/**
 * `POST /api/admin/users/:userId/clear-otp-lockout` (readiness-backlog
 * A5-3) — the support-incident-response lever for "user is locked out
 * of login and can't get in".
 *
 * TIER + STEP-UP DECISION (see the PR description for the full
 * reasoning): admin-tier, NOT step-up-gated. Modeled directly on the
 * B4 `revoke-sessions` precedent (`../auth/revoke-sessions-handler.ts`)
 * rather than the ADR 037 support-tier delivery-unsticking actions
 * (wallet reprovision / watcher-skip reopen / redemption re-fetch):
 * those re-drive work the customer already paid for and touch no
 * security control, whereas this action WEAKENS a brute-force defense
 * (B5) for one account — closer in kind to revoke-sessions (an
 * account-security lever) than to a delivery unstick. Kept at
 * admin-tier so a compromised or socially-engineered support session
 * can't unilaterally reopen the guess budget on an arbitrary account.
 * Not step-up-gated because, like revoke-sessions, it moves no value
 * and is self-limiting: clearing the counter doesn't grant access by
 * itself, it only lets the user try their code again, and any further
 * wrong guesses re-arm the same B5 lockout from a clean window. Unlike
 * revoke-sessions this DOES carry a required `reason` + Discord audit
 * (ADR 017-lite — the same envelope the support delivery-unsticking
 * actions use even though they move no money either) because clearing
 * a brute-force defense is a more security-relevant event than
 * signing a user out, and a reason gives an incident reviewer context
 * revoke-sessions doesn't need.
 *
 * Reuses `clearOtpAttempts` (`../auth/otp-attempt-counter.ts`) — the
 * SAME primitive a successful `verify-otp` uses to reset a user's
 * counter. No bespoke unlock path, so there's exactly one way a
 * lockout row gets cleared. Idempotent: deleting an already-clear (or
 * never-existing) counter row is a no-op success (`wasLocked: false`),
 * so a double-click or a retried request can't error.
 */
import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import type { AdminClearOtpLockoutResult } from '@loop/shared';
import { UUID_RE } from '../uuid.js';
import { db } from '../db/client.js';
import { otpAttemptCounters } from '../db/schema.js';
import { getUserById, type User } from '../db/users.js';
import { clearOtpAttempts } from '../auth/otp-attempt-counter.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  validateIdempotencyKey,
  withIdempotencyGuard,
} from './idempotency.js';

const log = logger.child({ handler: 'admin-clear-otp-lockout' });

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
  const reason =
    body !== null && typeof body === 'object' ? (body as Record<string, unknown>)['reason'] : null;
  if (typeof reason !== 'string' || reason.length < 2 || reason.length > 500) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'reason must be 2-500 chars' }, 400);
  }

  // Pre-classify outside the guard so a bad userId never burns an
  // idempotency snapshot.
  let target;
  try {
    target = await getUserById(userId);
  } catch (err) {
    log.error({ err, userId }, 'Clear-otp-lockout target lookup failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to resolve target user' }, 500);
  }
  if (target === null) {
    return c.json({ code: 'USER_NOT_FOUND', message: 'User not found' }, 404);
  }
  const targetEmail = target.email;

  let guardResult: Awaited<ReturnType<typeof withIdempotencyGuard>>;
  try {
    guardResult = await withIdempotencyGuard(
      {
        adminUserId: actor.id,
        key: idempotencyKey,
        method: 'POST',
        path: `/api/admin/users/${userId}/clear-otp-lockout`,
      },
      async () => {
        const [lockRow] = await db
          .select({ lockedUntil: otpAttemptCounters.lockedUntil })
          .from(otpAttemptCounters)
          .where(eq(otpAttemptCounters.email, targetEmail))
          .limit(1);
        const wasLocked =
          lockRow?.lockedUntil !== null &&
          lockRow?.lockedUntil !== undefined &&
          lockRow.lockedUntil.getTime() > Date.now();

        // B5: the SAME clear primitive a successful verify-otp uses —
        // no bespoke unlock path.
        await clearOtpAttempts(targetEmail);

        const result: AdminClearOtpLockoutResult = { userId, wasLocked, cleared: true };
        const envelope: AdminAuditEnvelope<AdminClearOtpLockoutResult> = buildAuditEnvelope({
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
    log.error({ err, userId, actorUserId: actor.id }, 'Clear OTP lockout failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to clear OTP lockout' }, 500);
  }

  if (guardResult.status === 200) {
    log.warn(
      { userId, adminUserId: actor.id, replayed: guardResult.replayed },
      'A5-3: admin cleared OTP lockout for user (incident response)',
    );
    notifyAdminAudit({
      actorUserId: actor.id,
      endpoint: `POST /api/admin/users/${userId}/clear-otp-lockout`,
      targetUserId: userId,
      reason,
      idempotencyKey,
      replayed: guardResult.replayed,
    });
  }

  return c.json(guardResult.body, guardResult.status as 200 | 500);
}
