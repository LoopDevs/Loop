/**
 * Loop-native auth handlers (ADR 013). Activated by the
 * `LOOP_AUTH_NATIVE_ENABLED` env flag; dispatchers in `handler.ts`
 * route requests here when the flag is on.
 *
 * Ships the full Loop-native trio: request-otp, verify-otp, refresh.
 * Users never see CTX; all user identity is Loop-internal.
 */
import type { Context } from 'hono';
import { logger } from '../logger.js';
import { findLiveOtp, incrementOtpAttempts, markOtpConsumed } from './otps.js';
import { normalizeEmail, NonAsciiEmailError } from './normalize-email.js';
import {
  signLoopToken,
  verifyLoopToken,
  DEFAULT_ACCESS_TTL_SECONDS,
  DEFAULT_REFRESH_TTL_SECONDS,
  isLoopAuthConfigured,
} from './tokens.js';
import { findOrCreateUserByEmail } from '../db/users.js';
import {
  recordRefreshToken,
  findLiveRefreshToken,
  findRefreshTokenRecord,
  revokeRefreshToken,
  revokeAllRefreshTokensForUser,
} from './refresh-tokens.js';

// A2-803 (auth slice): request-body schemas live in the shared
// `request-schemas.ts` module so both this Loop-native path and the
// CTX-proxy path (`handler.ts`) verify against the same source.
// Platform is forwarded only so the response envelope matches the
// CTX proxy's; the native path doesn't consume it today.
import { VerifyOtpBody, RefreshBody } from './request-schemas.js';

// `nativeRequestOtpHandler` (POST /api/auth/request-otp — native
// path) lives in `./native-request-otp.ts`. Re-exported here so
// the dispatcher in `auth/handler.ts` keeps importing from the
// historical `./native.js` path.
export { nativeRequestOtpHandler } from './native-request-otp.js';

const log = logger.child({ handler: 'auth-native' });

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /**
   * A2-557: jti of the freshly-minted refresh token. Returned
   * alongside the token strings so `nativeRefreshHandler` can
   * populate the `replacedByJti` link on the prior row without
   * re-verifying the token it just signed. The client contract
   * (`{ accessToken, refreshToken }`) is unchanged — this field is
   * internal and stripped at the handler boundary via destructure.
   */
  refreshJti: string;
}

/**
 * Mints a fresh access + refresh pair for `user` and persists the
 * refresh row. Shared by `verify-otp` (first issue) and `refresh`
 * (rotation). Returns the token strings to send to the client plus
 * the refresh `jti` for internal revoke-linking (A2-557).
 */
async function issueTokenPair(user: { id: string; email: string }): Promise<TokenPair> {
  const access = signLoopToken({
    sub: user.id,
    email: user.email,
    typ: 'access',
    ttlSeconds: DEFAULT_ACCESS_TTL_SECONDS,
  });
  const refresh = signLoopToken({
    sub: user.id,
    email: user.email,
    typ: 'refresh',
    ttlSeconds: DEFAULT_REFRESH_TTL_SECONDS,
  });
  if (refresh.claims.jti === undefined) {
    // signLoopToken always sets jti on a refresh; this branch keeps
    // TS narrowing clean without an `!` assertion.
    throw new Error('refresh token missing jti');
  }
  await recordRefreshToken({
    jti: refresh.claims.jti,
    userId: user.id,
    token: refresh.token,
    expiresAt: new Date(refresh.claims.exp * 1000),
  });
  return {
    accessToken: access.token,
    refreshToken: refresh.token,
    refreshJti: refresh.claims.jti,
  };
}

/**
 * POST /api/auth/verify-otp — native path.
 *
 * Consumes the OTP row (single-use), creates-or-finds the Loop user
 * by email, mints a Loop access/refresh pair, persists the refresh
 * row. Returns `{ accessToken, refreshToken }` — identical shape to
 * the CTX-proxy path so the client is agnostic.
 *
 * Wrong-code guesses bump the per-row `attempts` counter; after
 * `OTP_MAX_ATTEMPTS` the row is excluded from `findLiveOtp` and
 * further tries 401. Expired / missing rows also 401.
 */
export async function nativeVerifyOtpHandler(c: Context): Promise<Response> {
  if (!isLoopAuthConfigured()) {
    // Feature-flag-on without signing key set — refuse loudly rather
    // than silently mint unsigned tokens.
    log.error('LOOP_AUTH_NATIVE_ENABLED without LOOP_JWT_SIGNING_KEY');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Auth not configured' }, 500);
  }
  const parsed = VerifyOtpBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'email and otp are required' }, 400);
  }
  let email: string;
  try {
    email = normalizeEmail(parsed.data.email);
  } catch (err) {
    if (err instanceof NonAsciiEmailError) {
      // A2-2002: same generic shape as request-otp. Verify shouldn't
      // confirm "your email looks valid but" either.
      return c.json({ code: 'VALIDATION_ERROR', message: 'email and otp are required' }, 400);
    }
    throw err;
  }

  try {
    const hit = await findLiveOtp({ email, code: parsed.data.otp });
    if (hit === null) {
      // Bump the per-row attempts counter on any guess so brute force
      // against a specific row gets squeezed. No-ops if no live row.
      await incrementOtpAttempts({ email });
      return c.json({ code: 'UNAUTHORIZED', message: 'Invalid or expired verification code' }, 401);
    }
    await markOtpConsumed(hit.id);
    const user = await findOrCreateUserByEmail(email);
    const pair = await issueTokenPair({ id: user.id, email: user.email });
    // A2-557: strip the internal `refreshJti` field; wire contract
    // stays `{ accessToken, refreshToken }`.
    return c.json({ accessToken: pair.accessToken, refreshToken: pair.refreshToken });
  } catch (err) {
    log.error({ err, email }, 'Native verify-otp failed unexpectedly');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Verification failed' }, 500);
  }
}

/**
 * POST /api/auth/refresh — native path.
 *
 * Rotates the refresh token: verifies the JWT signature + typ, checks
 * the `refresh_tokens` row is live and hash-matches, revokes the old
 * row, writes a new pair. A reused refresh (already revoked) is a
 * strong signal of token theft — we revoke all of that user's
 * sessions defensively and reject the request.
 */
export async function nativeRefreshHandler(c: Context): Promise<Response> {
  if (!isLoopAuthConfigured()) {
    log.error('LOOP_AUTH_NATIVE_ENABLED without LOOP_JWT_SIGNING_KEY');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Auth not configured' }, 500);
  }
  const parsed = RefreshBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'refreshToken is required' }, 400);
  }

  try {
    const verified = verifyLoopToken(parsed.data.refreshToken, 'refresh');
    if (!verified.ok) {
      return c.json({ code: 'UNAUTHORIZED', message: 'Invalid refresh token' }, 401);
    }
    const { claims } = verified;
    if (claims.jti === undefined) {
      return c.json({ code: 'UNAUTHORIZED', message: 'Refresh token missing jti' }, 401);
    }
    const row = await findLiveRefreshToken({
      jti: claims.jti,
      token: parsed.data.refreshToken,
    });
    if (row === null) {
      // A2-1608: distinguish two rejection modes:
      //   - record exists but revokedAt != null → reuse of a rotated
      //     refresh. Only an attacker presenting a previously-valid
      //     token (already rotated out) can reach this branch; the
      //     legitimate client has the successor token. Revoke the
      //     entire family so the attacker's stolen lineage dies.
      //   - record missing → forged / cleaned-up row. 401 alone.
      const record = await findRefreshTokenRecord(claims.jti);
      if (record !== null && record.revokedAt !== null) {
        log.error(
          { jti: claims.jti, sub: claims.sub, userId: record.userId },
          'Refresh-token reuse detected — revoking all refresh tokens for user',
        );
        await revokeAllRefreshTokensForUser(record.userId);
      } else {
        log.warn({ jti: claims.jti, sub: claims.sub }, 'Refresh token not live');
      }
      return c.json({ code: 'UNAUTHORIZED', message: 'Invalid refresh token' }, 401);
    }

    const pair = await issueTokenPair({ id: claims.sub, email: claims.email });
    // Revoke the old row after issuing the new one — if the new-row
    // insert fails the old row is still usable on a retry. A2-557:
    // `issueTokenPair` already knows the new refresh jti from
    // signing; no need to re-verify the token string to extract it.
    await revokeRefreshToken({
      jti: claims.jti,
      replacedByJti: pair.refreshJti,
    });
    // Strip the internal `refreshJti` field before returning to the
    // client — the wire contract stays `{ accessToken, refreshToken }`.
    return c.json({ accessToken: pair.accessToken, refreshToken: pair.refreshToken });
  } catch (err) {
    log.error({ err }, 'Native refresh failed unexpectedly');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Refresh failed' }, 500);
  }
}
