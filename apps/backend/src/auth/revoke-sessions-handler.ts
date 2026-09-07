/**
 * Session-revocation handler (hardening B4).
 *
 * `DELETE /api/auth/session/all` (self) — revokes every live refresh
 * token for the caller ("sign out all devices"). Loop-native only:
 * CTX-proxy sessions are revoked upstream, and there is no local row
 * to revoke, so a `ctx`-kind caller succeeds as a no-op.
 *
 * NS-09: access tokens die too — `revokeAllRefreshTokensForUser`
 * bumps the user's `tokenVersion` alongside the refresh-row revoke,
 * and `requireAuth` rejects any access token whose `tv` claim no
 * longer matches.
 */
import type { Context } from 'hono';
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
