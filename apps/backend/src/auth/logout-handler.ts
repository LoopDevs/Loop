// DELETE /api/auth/session — best-effort logout — A2-565, NS-09, COR-11
import type { Context } from 'hono';
import { z } from 'zod';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { upstreamUrl, upstreamFetch } from '../upstream.js';
import { verifyLoopToken, isLoopAuthConfigured } from './tokens.js';
import { revokeRefreshToken } from './refresh-tokens.js';
import { bumpUserTokenVersion } from '../db/users.js';
import { PlatformEnum } from './request-schemas.js';

const log = logger.child({ handler: 'auth' });

function clientIdForPlatform(platform: 'web' | 'ios' | 'android'): string {
  if (platform === 'ios') return config.ctx.clientIds.ios;
  if (platform === 'android') return config.ctx.clientIds.android;
  return config.ctx.clientIds.web;
}

const LogoutBody = z.object({
  refreshToken: z.string().min(1).optional(),
  platform: PlatformEnum,
});

export async function logoutHandler(c: Context): Promise<Response> {
  const parsed = LogoutBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ message: 'Logged out' });
  }

  // A2-565: local revoke before upstream call to ensure it happens even if upstream throws.
  if (parsed.data.refreshToken !== undefined && isLoopAuthConfigured()) {
    const verified = verifyLoopToken(parsed.data.refreshToken, 'refresh');
    if (verified.ok) {
      // NS-09: bump token_version to invalidate all access tokens; other devices re-mint via live refresh tokens.
      try {
        await bumpUserTokenVersion(verified.claims.sub);
      } catch (err) {
        log.warn(
          { err, userId: verified.claims.sub },
          'NS-09: token_version bump on logout failed',
        );
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
  }

  const authHeader = c.req.header('Authorization');
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (bearer === null) {
    return c.json({ message: 'Logged out' });
  }

  if (isLoopAuthConfigured()) {
    // Forward only definitively foreign bearers; Loop tokens (expired/wrong_type/etc) must not cross.
    const verified = verifyLoopToken(bearer, 'access');
    const isForeign =
      !verified.ok && (verified.reason === 'bad_signature' || verified.reason === 'malformed');
    if (!isForeign) {
      return c.json({ message: 'Logged out' });
    }
  }

  try {
    const response = await upstreamFetch(upstreamUrl('/logout'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'X-Client-Id': clientIdForPlatform(parsed.data.platform),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      log.warn(
        { status: response.status },
        'Upstream logout returned non-success — token may still be valid upstream',
      );
    }
  } catch (err) {
    log.warn({ err }, 'Logout upstream call failed');
  }

  return c.json({ message: 'Logged out' });
}
