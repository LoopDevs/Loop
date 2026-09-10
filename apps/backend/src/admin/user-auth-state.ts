// Login / OTP support state — A5-3, ADR 037 §3
import type { Context } from 'hono';
import type { AdminUserAuthStateResponse } from '@loop/shared';
import { UUID_RE } from '../uuid.js';
import { db } from '../db/client.js';
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
    const now = new Date();
    const [lock, lastRequested, lastVerified, activeSessionCount] = await Promise.all([
      db.collection('otp_attempt_counters').findOne({ email }),
      db.collection('otps').findOne({ email }, { sort: [['createdAt', 'desc']] }),
      db
        .collection('otps')
        .findOne({ email, consumedAt: { $ne: null } }, { sort: [['consumedAt', 'desc']] }),
      db.collection('refresh_tokens').count({
        userId,
        revokedAt: null,
        expiresAt: { $gt: now },
      }),
    ]);

    const lockedUntil = lock?.lockedUntil ?? null;
    const locked = lockedUntil !== null && lockedUntil.getTime() > now.getTime();

    const body: AdminUserAuthStateResponse = {
      userId,
      otpLock: {
        locked,
        lockedUntil: lockedUntil !== null ? lockedUntil.toISOString() : null,
        failedAttempts: lock?.failedAttempts ?? 0,
      },
      lastOtpRequestedAt: lastRequested?.createdAt.toISOString() ?? null,
      lastOtpVerifiedAt: lastVerified?.consumedAt?.toISOString() ?? null,
      activeSessionCount,
    };
    return c.json(body);
  } catch (err) {
    log.error({ err, userId }, 'Admin user auth-state lookup failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load auth state' }, 500);
  }
}
