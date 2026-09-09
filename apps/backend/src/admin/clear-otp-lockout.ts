/**
 * `POST /api/admin/users/:userId/clear-otp-lockout` (readiness-backlog
 * A5-3) — the support lever for "user is locked out of login and
 * can't get in".
 *
 * TIER + STEP-UP DECISION. Admin-tier, NOT step-up-gated. Modelled on
 * the B4 `revoke-sessions` precedent rather than the support-tier
 * delivery-unsticking actions: those re-drive work the customer
 * already paid for and touch no security control, whereas this one
 * WEAKENS a brute-force defence for one account — closer in kind to an
 * account-security lever than to a delivery unstick. Kept at
 * admin-tier so a socially-engineered support session can't reopen the
 * guess budget on an arbitrary account. Not step-up-gated because,
 * like revoke-sessions, it moves no value and is self-limiting:
 * clearing the counter grants no access by itself, it only lets the
 * user try their code again, and a further wrong guess re-arms the
 * same lockout from a clean window. Unlike revoke-sessions it DOES
 * carry a required `reason` plus a Discord audit line, because
 * clearing a brute-force defence is a more security-relevant event
 * than signing somebody out and a reviewer needs the context.
 *
 * Reuses `clearOtpAttempts` — the SAME primitive a successful
 * `verify-otp` uses — so there is exactly one way a lockout row gets
 * cleared. Idempotent: clearing an already-clear (or never-existing)
 * counter is a no-op success (`wasLocked: false`), so a double-click
 * can't error.
 *
 * PER-TARGET VELOCITY CAP (A5-3 review P1). The per-IP route limit
 * does NOT bound the "clear → guess → clear" loop: that loop needs
 * only one clear per minute or so, and a compromised bearer can
 * spread its clears across several IPs all aimed at ONE victim. So
 * clears are also capped PER TARGET in a rolling 24h window. This is
 * the control that actually bounds the loop. The count reuses the
 * `admin_idempotency_keys` audit rows — the path encodes the target,
 * a row exists only for an APPLIED clear, and replays don't inflate it
 * — so there is no new collection. Fail-CLOSED: if the count errors we
 * reject rather than allow an unbounded clear.
 *
 * The count → check → clear sequence is made indivisible against a
 * burst of DISTINCT idempotency keys by a per-target lock:
 * `withIdempotencyGuard` alone serialises only same-key callers, so
 * without it a burst of distinct-key clears at one target would all
 * read the same pre-write count and every one would slip past the cap.
 *
 * KNOWN GAP — the cap is simultaneously the ANTI-ABUSE budget (a
 * compromised bearer's erosion of the lockout) and the RECOVERY budget
 * (letting a genuinely locked-out victim back in). Those collide:
 * after the cap is spent the victim is unrecoverable in-product for
 * the rest of the window. Decoupling them needs a signal a plain
 * bearer lacks — a step-up-gated recovery override with its own
 * ceiling, or a distinct-actor budget — which is a security-design
 * decision beyond this handler.
 */
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

/**
 * Max clears APPLIED to one target inside `CLEAR_LOCKOUT_WINDOW_MS`.
 * Five is generous for the fat-fingered-the-code case (a legitimate
 * user needs one, occasionally two) and tight enough that the
 * clear→guess loop can't meaningfully erode the lockout's ceiling.
 * A code constant rather than a config key, to keep the surface small.
 */
export const CLEAR_LOCKOUT_MAX_PER_TARGET_PER_DAY = 5;

/**
 * Rolling window for the per-target cap. Pinned to the idempotency
 * replay TTL because the rows the count reads are only guaranteed
 * readable-as-replays for that long; a longer window would silently
 * miss nothing today (retention is years) but would couple the cap to
 * a retention setting an operator can change. Shorter-or-equal only
 * ever makes the cap stricter, which is the safe direction.
 */
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
    // The per-TARGET lock wraps the guard, not the other way round:
    // the cap is about one victim, and the guard only serialises one
    // (admin, key) pair.
    guardResult = await withKeyedLock(`clear-otp-lockout:${userId}`, async () =>
      withIdempotencyGuard(
        { adminUserId: actor.id, key: idempotencyKey, method: 'POST', path },
        async () => {
          // Fail-closed: a throw here rejects the action rather than
          // handing the caller a free, uncounted clear.
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
