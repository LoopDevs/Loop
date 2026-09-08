/**
 * `DELETE /api/auth/session` — best-effort logout.
 *
 * Lifted out of `./handler.ts` so the four CTX-proxy auth handlers
 * don't all share a single fat module. Logout is the odd one out:
 * unlike `request-otp` / `verify-otp` / `refresh`, it does not branch
 * on the `LOOP_AUTH_NATIVE_ENABLED` flag — it branches on what the
 * credentials themselves turn out to be: a Loop-signed refresh token
 * in the body drives the local row revoke, and a non-Loop bearer in
 * the Authorization header drives the upstream CTX revoke.
 *
 * Re-exported from `./handler.ts` so existing import sites (the
 * routes module + the test suite) keep resolving.
 */
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

/** Maps platform to the upstream CTX client ID. */
function clientIdForPlatform(platform: 'web' | 'ios' | 'android'): string {
  if (platform === 'ios') return config.ctx.clientIds.ios;
  if (platform === 'android') return config.ctx.clientIds.android;
  return config.ctx.clientIds.web;
}

const LogoutBody = z.object({
  refreshToken: z.string().min(1).optional(),
  platform: PlatformEnum,
});

/**
 * DELETE /api/auth/session — best-effort revoke + success.
 *
 * Two independent revocation jobs, each driven by its own credential:
 *
 *   - Loop-native refresh-row revoke + token_version bump, driven by
 *     the body's `refreshToken` when it verifies as Loop-signed. The
 *     body token stays necessary here — this route is not behind
 *     `requireAuth`, and an access token carries no `jti`, so the
 *     refresh token is the only handle on the specific device row.
 *
 *   - Upstream CTX revoke, driven by the request's `Authorization`
 *     bearer. CTX's `POST /logout` authenticates like every other CTX
 *     endpoint — `Authorization: Bearer <accessToken>` plus an
 *     `X-Client-Id` header, no body — and deletes the access/refresh
 *     pair server-side. Forwarded ONLY when the bearer is not
 *     Loop-shaped: a Loop-signed token (valid, expired, or
 *     wrong-typed — anything past the signature check) never reaches
 *     CTX, closing the old always-fire path that posted Loop tokens
 *     at CTX in native mode.
 *
 * Errors in either job are logged and swallowed: the client has
 * already decided to log out, so failing the request would just trap
 * tokens in-store. The client always clears local state on 200.
 */
export async function logoutHandler(c: Context): Promise<Response> {
  const parsed = LogoutBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    // Unparseable body — nothing to act on. Still succeed so the
    // client proceeds with local clear.
    return c.json({ message: 'Logged out' });
  }

  // A2-565: when the refresh token is Loop-signed, revoke the row so
  // the 30-day TTL doesn't keep it live server-side. Do this before
  // the upstream call — if upstream throws, we still want the local
  // revoke to have happened. verifyLoopToken ignores tokens from
  // other issuers / audiences (A2-1600), so a CTX-signed bearer
  // falls through harmlessly.
  if (parsed.data.refreshToken !== undefined && isLoopAuthConfigured()) {
    const verified = verifyLoopToken(parsed.data.refreshToken, 'refresh');
    if (verified.ok) {
      // NS-09: bump the user's token_version so every already-issued
      // ACCESS token (15-min TTL, no per-token DB row) is rejected on
      // its next requireAuth check. Without this a logout revoked only
      // the refresh token, leaving the still-signed access token valid
      // for up to its full TTL — the exact gap NS-09 closes. Per-user
      // granularity: this bump invalidates the access tokens of ALL the
      // user's devices, but a device that is NOT logging out still holds
      // a live refresh token and transparently re-mints an access token
      // carrying the new `tv` — so other devices see one silent refresh,
      // not a logout. (A true "sign out everywhere" is
      // DELETE /api/auth/session/all, which revokes every refresh row
      // AND bumps token_version.) Done off the verified refresh token's
      // `sub` — this route is not behind requireAuth, so the refresh
      // token is the only authenticated identity available here.
      try {
        await bumpUserTokenVersion(verified.claims.sub);
      } catch (err) {
        // Non-fatal: the client still clears local state, and the access
        // token expires at its exp regardless. Log and continue.
        log.warn(
          { err, userId: verified.claims.sub },
          'NS-09: token_version bump on logout failed',
        );
      }
      if (verified.claims.jti !== undefined) {
        try {
          // COR-11: revoke by jti WITHOUT passing a successor. The token
          // presented here may already be mid-chain (a stale device or a
          // rotated-out token still within its signature TTL — verify
          // above checks the signature, not DB liveness). Passing no
          // `replacedByJti` leaves the row's rotation link intact, so the
          // audit chain stays traceable past the logout; `revoked_at`
          // alone invalidates the token.
          await revokeRefreshToken({ jti: verified.claims.jti });
        } catch (err) {
          // Revocation failure is not fatal — the signed token still
          // expires at its exp regardless. Log and continue so the
          // upstream call still gets made.
          log.warn({ err, jti: verified.claims.jti }, 'Loop refresh-token revocation failed');
        }
      }
    }
  }

  const authHeader = c.req.header('Authorization');
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (bearer === null) {
    // The new CTX contract revokes by access token — without a bearer
    // there is nothing to send upstream. Local revoke (above) already
    // ran; the client clears its own state on 200.
    return c.json({ message: 'Logged out' });
  }

  if (isLoopAuthConfigured()) {
    // Forward only bearers that are definitively NOT ours. The reason
    // taxonomy makes this exact: a foreign (CTX) token always fails
    // the signature check (`bad_signature`, or `malformed` for
    // non-JWT garbage — forwarding that is a harmless CTX 401), while
    // our own tokens fail AFTER it (`expired` / `wrong_type` /
    // `wrong_issuer` / `wrong_audience`) and must never cross.
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
    // Upstream unreachable — client still gets its local clear.
    log.warn({ err }, 'Logout upstream call failed');
  }

  return c.json({ message: 'Logged out' });
}
