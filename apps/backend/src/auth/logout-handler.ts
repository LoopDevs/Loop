// DELETE /api/auth/session — best-effort logout — A2-565, NS-09, COR-11
import type { Context } from 'hono';
import { z } from 'zod';
import { logger } from '../logger.js';
import { verifyLoopToken } from './tokens.js';
import { revokeRefreshToken } from './refresh-tokens.js';
import { bumpUserTokenVersion } from '../db/users.js';

const log = logger.child({ handler: 'auth' });

const LogoutBody = z.object({
  refreshToken: z.string().min(1).optional(),
});

export async function logoutHandler(c: Context): Promise<Response> {
  const parsed = LogoutBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success || parsed.data.refreshToken === undefined) {
    return c.json({ message: 'Logged out' });
  }

  const verified = verifyLoopToken(parsed.data.refreshToken, 'refresh');
  if (verified.ok) {
    // NS-09: bump token_version to invalidate all access tokens; other devices re-mint via live refresh tokens.
    try {
      await bumpUserTokenVersion(verified.claims.sub);
    } catch (err) {
      log.warn({ err, userId: verified.claims.sub }, 'NS-09: token_version bump on logout failed');
    }
    if (verified.claims.jti !== undefined) {
      try {
        // COR-11: revoke by jti without successor to preserve audit chain traceability.
        await revokeRefreshToken({ jti: verified.claims.jti });
      } catch (err) {
        log.warn({ err, jti: verified.claims.jti }, 'Loop refresh-token revocation failed');
      }
    }
  }

  return c.json({ message: 'Logged out' });
}
