// Loop-native auth handlers — ADR 013
import type { Context } from 'hono';
import { logger } from '../logger.js';
import {
  findLiveOtp,
  incrementOtpAttempts,
  tryConsumeOtp,
  countRecentOtpsForEmail,
  OTP_TTL_MS,
} from './otps.js';
import {
  isEmailOtpLocked,
  registerFailedOtpAttempt,
  clearOtpAttempts,
  OTP_EMAIL_LOCKOUT_MS,
} from './otp-attempt-counter.js';
import { enqueueCtxUserProvisioning } from '../ctx/user-provisioning.js';
import { normalizeEmail, NonAsciiEmailError } from './normalize-email.js';
import { verifyLoopToken, isLoopAuthConfigured } from './tokens.js';
import { findOrCreateUserByEmail, getUserTokenVersion } from '../db/users.js';
import {
  findLiveRefreshToken,
  findRefreshTokenRecord,
  tryRevokeIfLive,
  revokeAllRefreshTokensForUser,
} from './refresh-tokens.js';

// A2-803: shared schemas prevent drift between native and CTX-proxy paths
import { VerifyOtpBody, RefreshBody } from './request-schemas.js';

export { nativeRequestOtpHandler } from './native-request-otp.js';

const log = logger.child({ handler: 'auth-native' });

export { issueTokenPair, type TokenPair } from './issue-token-pair.js';
import { issueTokenPair, mintTokenPair, persistMintedRefreshToken } from './issue-token-pair.js';

export async function nativeVerifyOtpHandler(c: Context): Promise<Response> {
  if (!isLoopAuthConfigured()) {
    // Refuse loudly to prevent minting unsigned tokens
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
      // A2-2002: avoid confirming email validity
      return c.json({ code: 'VALIDATION_ERROR', message: 'email and otp are required' }, 400);
    }
    throw err;
  }

  try {
    // B5: identity-level lockout prevents brute force via OTP rotation
    if (await isEmailOtpLocked({ email })) {
      c.header('Retry-After', String(Math.ceil(OTP_EMAIL_LOCKOUT_MS / 1000)));
      return c.json(
        { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Try again later.' },
        429,
      );
    }
    const hit = await findLiveOtp({ email, code: parsed.data.otp });
    if (hit === null) {
      await incrementOtpAttempts({ email });
      // SEC-15: gate lockout on live OTP existence to prevent unauth DoS
      const recentOtps = await countRecentOtpsForEmail({ email, windowMs: OTP_TTL_MS });
      if (recentOtps > 0) {
        // B5: authoritative per-email ceiling
        const { locked } = await registerFailedOtpAttempt({ email });
        if (locked) {
          c.header('Retry-After', String(Math.ceil(OTP_EMAIL_LOCKOUT_MS / 1000)));
          return c.json(
            { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Try again later.' },
            429,
          );
        }
      }
      return c.json({ code: 'UNAUTHORIZED', message: 'Invalid or expired verification code' }, 401);
    }
    // BK-otpatomic: atomic CAS ensures single-use enforcement
    const won = await tryConsumeOtp(hit.id);
    if (!won) {
      // Concurrent verify already consumed this OTP
      return c.json({ code: 'UNAUTHORIZED', message: 'Invalid or expired verification code' }, 401);
    }
    // B5: legitimate verify clears the email's failed-attempt counter
    await clearOtpAttempts(email);
    const user = await findOrCreateUserByEmail(email);
    // NS-09: stamp current token_version for invalidation support
    const pair = await issueTokenPair({
      id: user.id,
      email: user.email,
      tokenVersion: user.tokenVersion,
    });
    // Attributed-operator-traffic: self-heals provisioning on every login
    enqueueCtxUserProvisioning(user);
    // A2-557: strip internal fields for wire contract
    return c.json({ accessToken: pair.accessToken, refreshToken: pair.refreshToken });
  } catch (err) {
    log.error({ err, email }, 'Native verify-otp failed unexpectedly');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Verification failed' }, 500);
  }
}

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
      // A2-1608: distinguish reuse (revoke family) from missing record
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

    // A4-098: CAS rotation prevents parallel live successor lineages
    // NS-09: read live token_version to reflect recent bumps
    const tokenVersion = await getUserTokenVersion(claims.sub);
    if (tokenVersion === null) {
      log.warn({ sub: claims.sub }, 'Refresh for a user row that no longer exists');
      return c.json({ code: 'UNAUTHORIZED', message: 'Invalid refresh token' }, 401);
    }
    const minted = mintTokenPair({ id: claims.sub, email: claims.email, tokenVersion });
    const won = await tryRevokeIfLive({ jti: claims.jti, replacedByJti: minted.refreshJti });
    if (!won) {
      // Concurrent rotation lost the race
      log.warn(
        { jti: claims.jti, sub: claims.sub },
        'Refresh token rotation lost concurrent race — rejecting',
      );
      return c.json({ code: 'UNAUTHORIZED', message: 'Invalid refresh token' }, 401);
    }
    // Fail-closed: if persist fails, old token is revoked and successor is not stored
    await persistMintedRefreshToken(minted);
    // Strip internal fields for wire contract
    return c.json({ accessToken: minted.accessToken, refreshToken: minted.refreshToken });
  } catch (err) {
    log.error({ err }, 'Native refresh failed unexpectedly');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Refresh failed' }, 500);
  }
}
