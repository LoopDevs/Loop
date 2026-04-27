/**
 * `DELETE /api/auth/session` — best-effort logout.
 *
 * Lifted out of `./handler.ts` so the four CTX-proxy auth handlers
 * don't all share a single fat module. Logout is the odd one out:
 * unlike `request-otp` / `verify-otp` / `refresh`, it does not have
 * a Loop-native counterpart on the `LOOP_AUTH_NATIVE_ENABLED` flag —
 * it always tries the upstream revoke (best-effort) and additionally
 * revokes any Loop-signed refresh-token row it can recognise.
 *
 * Re-exported from `./handler.ts` so existing import sites (the
 * routes module + the test suite) keep resolving.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { getUpstreamCircuit, CircuitOpenError } from '../circuit-breaker.js';
import { upstreamUrl } from '../upstream.js';
import { verifyLoopToken, isLoopAuthConfigured } from './tokens.js';
import { revokeRefreshToken } from './refresh-tokens.js';
import { PlatformEnum } from './request-schemas.js';

const log = logger.child({ handler: 'auth' });

/** Maps platform to the upstream CTX client ID. */
function clientIdForPlatform(platform: 'web' | 'ios' | 'android'): string {
  if (platform === 'ios') return env.CTX_CLIENT_ID_IOS;
  if (platform === 'android') return env.CTX_CLIENT_ID_ANDROID;
  return env.CTX_CLIENT_ID_WEB;
}

const LogoutBody = z.object({
  refreshToken: z.string().min(1).optional(),
  platform: PlatformEnum,
});

/**
 * DELETE /api/auth/session — best-effort upstream revoke + success.
 *
 * If the client supplies a refresh token we try to revoke it upstream so a
 * leaked token can't outlive the user's intent to log out. Upstream errors
 * are logged and swallowed: the client has already decided to log out, so
 * failing the request would just trap the token in-store. The client
 * always clears local state on receiving 200.
 */
export async function logoutHandler(c: Context): Promise<Response> {
  const parsed = LogoutBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success || parsed.data.refreshToken === undefined) {
    // No token in body — nothing to revoke upstream. Still succeed so the
    // client proceeds with local clear.
    return c.json({ message: 'Logged out' });
  }

  // A2-565: when the refresh token is Loop-signed, revoke the row so
  // the 30-day TTL doesn't keep it live server-side. Do this before
  // the upstream call — if upstream throws, we still want the local
  // revoke to have happened. verifyLoopToken ignores tokens from
  // other issuers / audiences (A2-1600), so a CTX-signed bearer
  // falls through harmlessly.
  if (isLoopAuthConfigured()) {
    const verified = verifyLoopToken(parsed.data.refreshToken, 'refresh');
    if (verified.ok && verified.claims.jti !== undefined) {
      try {
        await revokeRefreshToken({ jti: verified.claims.jti });
      } catch (err) {
        // Revocation failure is not fatal — the signed token still
        // expires at its exp regardless. Log and continue so the
        // upstream call still gets made.
        log.warn({ err, jti: verified.claims.jti }, 'Loop refresh-token revocation failed');
      }
    }
  }

  try {
    const response = await getUpstreamCircuit('logout').fetch(upstreamUrl('/logout'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refreshToken: parsed.data.refreshToken,
        clientId: clientIdForPlatform(parsed.data.platform),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      log.warn(
        { status: response.status },
        'Upstream logout returned non-success — token may still be valid upstream',
      );
    }
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      // Upstream unreachable — client still gets its local clear.
      log.info('Logout attempted while upstream circuit open');
    } else {
      log.warn({ err }, 'Logout upstream call failed');
    }
  }

  return c.json({ message: 'Logged out' });
}
