/**
 * Login / OTP support state (readiness-backlog A5-3).
 *
 * `GET /api/admin/users/:userId/auth-state` — read-only snapshot of
 * an account's B5 verify-otp lockout state, OTP issuance/verify
 * history, and live-session count, so support can answer "is this
 * user locked out right now, and why" without SQL. Support-tier
 * (ADR 037 §3 — read views are shared).
 *
 * Reuses the exact OTP-lock snapshot query the A5-7 audit timeline
 * already proved (`./user-audit-timeline.ts`'s "6. OTP-lock snapshot"
 * source) plus two new aggregate reads over `otps` (last request /
 * last successful verify) neither existing surface needed, and a
 * live-session count over `refresh_tokens` mirroring what
 * `revoke-sessions-handler.ts` would clear.
 *
 * NEVER returns an OTP code, a code hash, or a refresh-token hash —
 * `otps.codeHash` / `refreshTokens.tokenHash` are not selected by any
 * query here. This is deliberate: the point of this endpoint is to
 * let support see STATE without ever being able to reconstruct or
 * replay a login.
 */
import type { Context } from 'hono';
import { and, desc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import type { AdminUserAuthStateResponse } from '@loop/shared';
import { UUID_RE } from '../uuid.js';
import { db } from '../db/client.js';
import { otpAttemptCounters, otps, refreshTokens } from '../db/schema.js';
import { getUserById } from '../db/users.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-user-auth-state' });

export async function adminUserAuthStateHandler(c: Context): Promise<Response> {
  const userId = c.req.param('userId');
  if (userId === undefined || !UUID_RE.test(userId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a uuid' }, 400);
  }

  let user;
  try {
    user = await getUserById(userId);
  } catch (err) {
    log.error({ err, userId }, 'Auth-state user lookup failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load auth state' }, 500);
  }
  if (user === null) {
    return c.json({ code: 'USER_NOT_FOUND', message: 'User not found' }, 404);
  }
  const email = user.email;

  try {
    const [lockRows, lastRequestRows, lastVerifyRows, activeSessionRows] = await Promise.all([
      db
        .select({
          lockedUntil: otpAttemptCounters.lockedUntil,
          failedAttempts: otpAttemptCounters.failedAttempts,
        })
        .from(otpAttemptCounters)
        .where(eq(otpAttemptCounters.email, email))
        .limit(1),
      db
        .select({ createdAt: otps.createdAt })
        .from(otps)
        .where(eq(otps.email, email))
        .orderBy(desc(otps.createdAt))
        .limit(1),
      db
        .select({ consumedAt: otps.consumedAt })
        .from(otps)
        .where(and(eq(otps.email, email), isNotNull(otps.consumedAt)))
        .orderBy(desc(otps.consumedAt))
        .limit(1),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(refreshTokens)
        .where(
          and(
            eq(refreshTokens.userId, userId),
            isNull(refreshTokens.revokedAt),
            gt(refreshTokens.expiresAt, new Date()),
          ),
        ),
    ]);

    const lock = lockRows[0];
    const lockedUntil = lock?.lockedUntil ?? null;
    const locked = lockedUntil !== null && lockedUntil.getTime() > Date.now();

    const body: AdminUserAuthStateResponse = {
      userId,
      otpLock: {
        locked,
        lockedUntil: lockedUntil !== null ? lockedUntil.toISOString() : null,
        failedAttempts: lock?.failedAttempts ?? 0,
      },
      lastOtpRequestedAt: lastRequestRows[0]?.createdAt?.toISOString() ?? null,
      lastOtpVerifiedAt: lastVerifyRows[0]?.consumedAt?.toISOString() ?? null,
      activeSessionCount: activeSessionRows[0]?.n ?? 0,
    };
    return c.json(body);
  } catch (err) {
    log.error({ err, userId }, 'Admin user auth-state lookup failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load auth state' }, 500);
  }
}
