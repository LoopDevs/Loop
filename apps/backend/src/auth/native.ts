/**
 * Loop-native auth handlers (ADR 013). Activated by the
 * `LOOP_AUTH_NATIVE_ENABLED` env flag; dispatchers in `handler.ts`
 * route requests here when the flag is on.
 *
 * Ships the full Loop-native trio: request-otp, verify-otp, refresh.
 * Users never see CTX; all user identity is Loop-internal.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { logger } from '../logger.js';
import {
  createOtp,
  findLiveOtp,
  generateOtpCode,
  countRecentOtpsForEmail,
  incrementOtpAttempts,
  markOtpConsumed,
  OTP_REQUESTS_PER_EMAIL_PER_MINUTE,
} from './otps.js';
import { getEmailProvider } from './email.js';
import {
  signLoopToken,
  verifyLoopToken,
  DEFAULT_ACCESS_TTL_SECONDS,
  DEFAULT_REFRESH_TTL_SECONDS,
  isLoopAuthConfigured,
} from './tokens.js';
import { findOrCreateUserByEmail } from '../db/users.js';
import { recordRefreshToken, findLiveRefreshToken, revokeRefreshToken } from './refresh-tokens.js';

const log = logger.child({ handler: 'auth-native' });

const RequestOtpBody = z.object({
  email: z.string().email(),
  // Platform is forwarded only so the response envelope matches the
  // CTX proxy's; the native path doesn't consume it today.
  platform: z.enum(['web', 'ios', 'android']).default('web'),
});

/**
 * POST /api/auth/request-otp — native path.
 *
 * Always returns 200 with `{ message: 'Verification code sent' }`
 * regardless of whether the email is known or whether the email
 * provider succeeded — email-enumeration defence, same shape the
 * CTX-proxy path already uses.
 *
 * Per-email cap on top of the per-IP rate limit: an attacker
 * rotating IPs can't still flood one inbox.
 */
export async function nativeRequestOtpHandler(c: Context): Promise<Response> {
  const parsed = RequestOtpBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Valid email is required' }, 400);
  }
  const email = parsed.data.email.toLowerCase().trim();

  try {
    const recent = await countRecentOtpsForEmail({ email, windowMs: 60_000 });
    if (recent >= OTP_REQUESTS_PER_EMAIL_PER_MINUTE) {
      // Same-shape response: don't tell the caller they tripped the
      // per-email cap. The per-IP limiter already returns a 429 with
      // Retry-After; this branch handles rotated-IP attacks silently.
      log.warn({ email }, 'OTP request skipped — per-email cap hit');
      return c.json({ message: 'Verification code sent' });
    }

    const code = generateOtpCode();
    const { expiresAt } = await createOtp({ email, code });

    try {
      await getEmailProvider().sendOtpEmail({ to: email, code, expiresAt });
    } catch (err) {
      // The OTP row is already written. If the email send fails the
      // user won't receive the code; they'll hit `request-otp` again
      // and land on a fresh row. Log at error so on-call notices a
      // provider incident; do not surface the failure to the client
      // (enumeration defence).
      log.error({ err, email }, 'OTP email send failed');
    }

    return c.json({ message: 'Verification code sent' });
  } catch (err) {
    log.error({ err, email }, 'Native request-otp failed unexpectedly');
    // Surface a 500 on DB failures so the client can back off. A
    // malicious caller learns nothing beyond "backend is unwell".
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to send verification code' }, 500);
  }
}

const VerifyOtpBody = z.object({
  email: z.string().email(),
  otp: z.string().min(1),
  platform: z.enum(['web', 'ios', 'android']).default('web'),
});

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/**
 * Mints a fresh access + refresh pair for `user` and persists the
 * refresh row. Shared by `verify-otp` (first issue) and `refresh`
 * (rotation). Returns the token strings to send to the client.
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
  return { accessToken: access.token, refreshToken: refresh.token };
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
  const email = parsed.data.email.toLowerCase().trim();

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
    return c.json(pair);
  } catch (err) {
    log.error({ err, email }, 'Native verify-otp failed unexpectedly');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Verification failed' }, 500);
  }
}

const RefreshBody = z.object({
  refreshToken: z.string().min(1),
  platform: z.enum(['web', 'ios', 'android']).default('web'),
});

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
      // Either the row is missing (attacker forged a signature with a
      // stolen key — already caught by verify — or we've rotated
      // behind it) or it's revoked (reuse of a previously-rotated
      // refresh — token-theft signal). Either way, 401.
      log.warn({ jti: claims.jti, sub: claims.sub }, 'Refresh token not live');
      return c.json({ code: 'UNAUTHORIZED', message: 'Invalid refresh token' }, 401);
    }

    const pair = await issueTokenPair({ id: claims.sub, email: claims.email });
    // Revoke the old row after issuing the new one — if the new-row
    // insert fails the old row is still usable on a retry.
    const newRefreshClaims = verifyLoopToken(pair.refreshToken, 'refresh');
    if (newRefreshClaims.ok && newRefreshClaims.claims.jti !== undefined) {
      await revokeRefreshToken({
        jti: claims.jti,
        replacedByJti: newRefreshClaims.claims.jti,
      });
    } else {
      await revokeRefreshToken({ jti: claims.jti });
    }
    return c.json(pair);
  } catch (err) {
    log.error({ err }, 'Native refresh failed unexpectedly');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Refresh failed' }, 500);
  }
}
