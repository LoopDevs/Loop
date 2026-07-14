/**
 * Session-revocation handlers (hardening B4).
 *
 * The `revokeAllRefreshTokensForUser` primitive existed but nothing
 * mounted it — there was no user-facing "sign out all devices" and no
 * admin "revoke this user's sessions". For a payments app with 30-day
 * refresh tokens that meant a stolen refresh token could only be
 * killed by the victim tripping the reuse heuristic or waiting out the
 * TTL. These two endpoints close that gap.
 *
 *   - `DELETE /api/auth/session/all` (self) — revokes every live
 *     refresh token for the caller. Loop-native only: CTX-proxy
 *     sessions are revoked upstream, and there is no local row to
 *     revoke, so a `ctx`-kind caller succeeds as a no-op.
 *   - `POST /api/admin/users/:userId/revoke-sessions` (admin) —
 *     revokes a target user's live refresh tokens. The incident-
 *     response lever for a compromised account.
 *
 * NS-09: access tokens are now revocable too. `revokeAllRefreshTokens
 * ForUser` bumps the user's `token_version` in the same transaction as
 * the refresh-row revoke, and `requireAuth` rejects any access token
 * whose `tv` claim no longer matches — so the compromised session's
 * access tokens die immediately, not after the (previous) up-to-15-min
 * access-token window. (Historically access tokens were non-revocable
 * by design — no `jti`, 15-min TTL, verified in-process; NS-09 closed
 * that gap. See docs/threat-model.md.)
 */
import type { Context } from 'hono';
import { UUID_RE } from '../uuid.js';
import { getUserById, type User } from '../db/users.js';
import { revokeAllRefreshTokensForUser } from './refresh-tokens.js';
import type { LoopAuthContext } from './require-auth.js';
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

export interface AdminRevokeSessionsResponse {
  userId: string;
  message: string;
}

/**
 * `POST /api/admin/users/:userId/revoke-sessions` — admin kills a
 * target user's live sessions (incident response). Admin-tier;
 * NOT step-up-gated (it moves no value and is reversible — the user
 * just signs back in — so gating it on a fresh password re-entry would
 * add friction to a fast-response security action; see the exempt-list
 * entry in staff-route-gating.test.ts).
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
  const body: AdminRevokeSessionsResponse = {
    userId,
    message: 'All sessions revoked',
  };
  return c.json(body);
}
