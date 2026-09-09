/**
 * Session-revocation handler (hardening B4).
 *
 * `DELETE /api/auth/session/all` (self) — revokes every live refresh
 * token for the caller ("sign out all devices"). Loop-native only:
 * CTX-proxy sessions are revoked upstream, and there is no local row
 * to revoke, so a `ctx`-kind caller succeeds as a no-op.
 *
 * `POST /api/admin/users/:userId/revoke-sessions` (admin) — the same
 * revocation aimed at somebody else, as an incident-response lever
 * ("this account is compromised, sign it out everywhere now").
 *
 * NS-09: access tokens die too — `revokeAllRefreshTokensForUser`
 * bumps the user's `tokenVersion` alongside the refresh-row revoke,
 * and `requireAuth` rejects any access token whose `tv` claim no
 * longer matches.
 */
import type { Context } from 'hono';
import { revokeAllRefreshTokensForUser } from './refresh-tokens.js';
import type { LoopAuthContext } from './require-auth.js';
import { getUserById, type User } from '../db/users.js';
import { UUID_RE } from '../uuid.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'revoke-sessions' });

/**
 * `DELETE /api/auth/session/all` — the caller signs out everywhere.
 * Requires `requireAuth` upstream. Loop-native callers get every live
 * refresh token revoked; CTX-proxy callers (no local session row)
 * succeed as a no-op so the client still clears local state.
 */
export async function revokeAllOwnSessionsHandler(c: Context): Promise<Response> {
  const auth = c.get('auth') as LoopAuthContext | undefined;
  if (auth === undefined) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
  }
  if (auth.kind !== 'loop') {
    // CTX-proxy session — no local refresh-token rows to revoke; the
    // upstream logout is the mechanism there. Succeed so the client
    // clears local state.
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

/** `POST /api/admin/users/:userId/revoke-sessions` response body. */
export interface AdminRevokeSessionsResponse {
  userId: string;
  message: string;
}

/**
 * `POST /api/admin/users/:userId/revoke-sessions` (hardening B4) —
 * admin-tier incident response: sign one user out everywhere.
 *
 * Not step-up-gated, unlike the other admin writes. It moves no value
 * and is trivially recoverable (the user signs back in), and step-up
 * friction in the middle of a fast security response is the wrong
 * trade — the point of the lever is to be usable in the first minute
 * of "their laptop was stolen". The staff-route inventory records this
 * as a deliberate exemption rather than an oversight.
 */
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
