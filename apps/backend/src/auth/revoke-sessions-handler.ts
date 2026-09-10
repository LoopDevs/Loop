// Session-revocation handler — B4
import type { Context } from 'hono';
import { revokeAllRefreshTokensForUser } from './refresh-tokens.js';
import type { LoopAuthContext } from './require-auth.js';
import { getUserById, type User } from '../db/users.js';
import { UUID_RE } from '../uuid.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'revoke-sessions' });

export async function revokeAllOwnSessionsHandler(c: Context): Promise<Response> {
  const auth = c.get('auth') as LoopAuthContext | undefined;
  if (auth === undefined) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
  }
  if (auth.kind !== 'loop') {
    // CTX-proxy: no local rows; upstream handles revocation
    return c.json({ message: 'Signed out of all devices' });
  }
  try {
    await revokeAllRefreshTokensForUser(auth.userId);
  } catch (err) {
    log.error({ err, userId: auth.userId }, 'B4: self sign-out-all failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to revoke sessions' }, 500);
  }
  log.info({ userId: auth.userId }, 'B4: user signed out of all devices');
  return c.json({ message: 'Signed out of all devices' });
}

export interface AdminRevokeSessionsResponse {
  userId: string;
  message: string;
}

// Not step-up-gated: trivially recoverable, avoids friction during incident response
export async function adminRevokeUserSessionsHandler(c: Context): Promise<Response> {
  const userId = c.req.param('userId');
  if (userId === undefined || !UUID_RE.test(userId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a uuid' }, 400);
  }
  const actor = c.get('user') as User | undefined;
  const target = await getUserById(userId);
  if (target === null) {
    return c.json({ code: 'NOT_FOUND', message: 'Target user not found' }, 404);
  }
  try {
    await revokeAllRefreshTokensForUser(userId);
  } catch (err) {
    log.error({ err, userId, adminUserId: actor?.id }, 'B4: admin session revoke failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to revoke sessions' }, 500);
  }
  log.warn(
    { userId, adminUserId: actor?.id },
    'B4: admin revoked all sessions for user (incident response)',
  );
  return c.json<AdminRevokeSessionsResponse>({ userId, message: 'All sessions revoked' });
}
