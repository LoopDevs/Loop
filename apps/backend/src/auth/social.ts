/**
 * Social-login handlers — Google + Apple (ADR 014).
 *
 * Both providers share the same flow:
 *   1. Client sends `{ idToken }` minted by Google / Apple on device.
 *   2. We verify the id_token against the provider's JWKS
 *      (`verifyIdToken`, ADR 014 slice 2).
 *   3. We extract `sub`, `email`, `email_verified` and resolve-or-
 *      create a Loop user (`resolveOrCreateUserForIdentity`, slice 1).
 *   4. We mint a Loop access + refresh pair and persist the refresh
 *      row — identical to the OTP path's final leg (ADR 013).
 *
 * Handlers live behind `LOOP_AUTH_NATIVE_ENABLED`. Each provider's
 * handler additionally 404s if its own audience is unconfigured —
 * that keeps a partially-deployed environment (Google set up but
 * not Apple, for example) from leaking endpoints that would only
 * 401 the client.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { logger } from '../logger.js';
import { env } from '../env.js';
import { verifyIdToken, type VerifyIdTokenResult } from './id-token.js';
import { consumeIdToken } from './id-token-replay.js';
import { resolveOrCreateUserForIdentity } from './identities.js';
import {
  signLoopToken,
  DEFAULT_ACCESS_TTL_SECONDS,
  DEFAULT_REFRESH_TTL_SECONDS,
  isLoopAuthConfigured,
} from './tokens.js';
import { recordRefreshToken } from './refresh-tokens.js';
import type { SocialProvider } from '../db/schema.js';

const log = logger.child({ handler: 'auth-social' });

const Body = z.object({
  idToken: z.string().min(1),
  platform: z.enum(['web', 'ios', 'android']).default('web'),
});

export interface SocialProviderConfig {
  provider: SocialProvider;
  /** URL of the provider's JWKS. */
  jwksUrl: string;
  /**
   * A2-567: list of acceptable `iss` values. Google's id_token is
   * documented to carry either `https://accounts.google.com` or
   * `accounts.google.com` depending on SDK version, and exact-match
   * on a single string rejected the scheme-less variant. Pass the
   * set of valid strings; verification accepts any member.
   */
  expectedIssuers: string[];
  /**
   * Resolves the allowed `aud` list from the environment. An empty
   * array means this provider isn't configured in this deployment —
   * the handler returns 404.
   */
  resolveAudiences: () => string[];
}

/**
 * Mints + persists an access/refresh pair for `user`. Identical
 * shape to the verify-otp path's issueTokenPair; factored here so
 * social-login calls don't re-import auth/native.ts (which would
 * drag the OTP-specific dependencies into the social module).
 */
async function issueTokenPair(user: {
  id: string;
  email: string;
}): Promise<{ accessToken: string; refreshToken: string }> {
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
 * Factory: given a provider config, returns a Hono handler for
 * `POST /api/auth/social/<provider>`. Every reject path maps to a
 * 401 with a generic "Invalid id_token" message so a probe can't
 * tell which check (iss / aud / expiry / signature) failed.
 */
export function makeSocialLoginHandler(config: SocialProviderConfig) {
  return async function socialLoginHandler(c: Context): Promise<Response> {
    if (!env.LOOP_AUTH_NATIVE_ENABLED) {
      return c.json({ code: 'NOT_FOUND', message: 'Not found' }, 404);
    }
    if (!isLoopAuthConfigured()) {
      log.error('LOOP_AUTH_NATIVE_ENABLED without LOOP_JWT_SIGNING_KEY');
      return c.json({ code: 'INTERNAL_ERROR', message: 'Auth not configured' }, 500);
    }
    const audiences = config.resolveAudiences();
    if (audiences.length === 0) {
      // Provider isn't configured in this deployment — 404 rather
      // than "configured but wrong aud" so a probe can't learn which
      // providers are live.
      return c.json({ code: 'NOT_FOUND', message: 'Not found' }, 404);
    }

    const parsed = Body.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ code: 'VALIDATION_ERROR', message: 'idToken required' }, 400);
    }

    let verified: VerifyIdTokenResult;
    try {
      verified = await verifyIdToken({
        token: parsed.data.idToken,
        jwksUrl: config.jwksUrl,
        expectedIssuers: config.expectedIssuers,
        expectedAudiences: audiences,
      });
    } catch (err) {
      // JWKS fetch failed or schema drift. The id_token may be
      // perfectly valid — we just can't reach the provider. 503
      // lets the client retry instead of the user thinking the
      // token was bad.
      log.error({ err, provider: config.provider }, 'JWKS fetch failed during social verify');
      return c.json(
        { code: 'SERVICE_UNAVAILABLE', message: 'Identity provider temporarily unavailable' },
        503,
      );
    }
    if (!verified.ok) {
      log.warn({ reason: verified.reason, provider: config.provider }, 'Social id_token rejected');
      return c.json({ code: 'UNAUTHORIZED', message: 'Invalid id_token' }, 401);
    }
    const claims = verified.claims;

    // A2-566: one-shot consume. A verified-once id_token is replayable
    // within its provider TTL without this — sha256(token) goes into
    // social_id_token_uses; a second attempt with the same token hits
    // the PK conflict and we reject with the same generic 401 as a
    // verify failure (don't tell the caller it was a replay).
    let firstUse: boolean;
    try {
      firstUse = await consumeIdToken({
        token: parsed.data.idToken,
        provider: config.provider,
        expSeconds: claims.exp,
      });
    } catch {
      // DB error is operational, not a replay. Surface as 503 so the
      // caller retries — silently passing would open a replay window.
      return c.json(
        { code: 'SERVICE_UNAVAILABLE', message: 'Auth service temporarily unavailable' },
        503,
      );
    }
    if (!firstUse) {
      return c.json({ code: 'UNAUTHORIZED', message: 'Invalid id_token' }, 401);
    }

    // `email` + `email_verified` are optional in the id_token spec
    // but required for our resolve-or-create policy: step 2 (link
    // by email) is only sound when the provider asserts
    // email_verified. Apple's relay emails come back with
    // email_verified=true (Apple has already validated deliverability).
    const email = typeof claims['email'] === 'string' ? claims['email'] : null;
    if (email === null) {
      log.warn({ provider: config.provider }, 'Social id_token missing email claim');
      return c.json({ code: 'UNAUTHORIZED', message: 'Provider did not share email' }, 401);
    }
    // Apple sometimes emits email_verified as a string "true"/"false";
    // coerce both shapes. Cast through unknown because the typed
    // IdTokenClaims shape narrows to boolean but Apple's JSON can
    // arrive as a string — the verifier preserves whatever was on
    // the wire.
    const raw = claims['email_verified'] as unknown;
    const emailVerified = raw === true || raw === 'true';
    if (!emailVerified) {
      log.warn({ provider: config.provider }, 'Social id_token email_verified=false');
      return c.json({ code: 'UNAUTHORIZED', message: 'Email not verified by provider' }, 401);
    }

    try {
      const { user } = await resolveOrCreateUserForIdentity({
        provider: config.provider,
        providerSub: claims.sub,
        email,
      });
      const pair = await issueTokenPair({ id: user.id, email: user.email });
      // Include email so the client can persist the session without
      // having to decode the Loop access JWT — mirrors what OTP users
      // get back (they typed their email; social users never did).
      return c.json({ ...pair, email: user.email });
    } catch (err) {
      log.error({ err, provider: config.provider }, 'Social login failed unexpectedly');
      return c.json({ code: 'INTERNAL_ERROR', message: 'Social sign-in failed' }, 500);
    }
  };
}

// ─── Per-provider wiring ──────────────────────────────────────────────────────

/**
 * Google social-login handler. Accepts id_tokens from any of the
 * configured per-platform client IDs — the mobile apps and the web
 * bundle each have their own OAuth client.
 */
export const googleSocialLoginHandler = makeSocialLoginHandler({
  provider: 'google',
  jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
  // A2-567: Google's documented `iss` values. The scheme-less form
  // still ships from older SDKs and server-side verification guides
  // explicitly list both — rejecting either breaks real users.
  expectedIssuers: ['https://accounts.google.com', 'accounts.google.com'],
  resolveAudiences: () =>
    [
      env.GOOGLE_OAUTH_CLIENT_ID_WEB,
      env.GOOGLE_OAUTH_CLIENT_ID_IOS,
      env.GOOGLE_OAUTH_CLIENT_ID_ANDROID,
    ].filter((v): v is string => typeof v === 'string' && v.length > 0),
});

/**
 * Apple Sign In handler. The service ID (web) or bundle id (native)
 * is the one audience we accept; Apple uses a single identifier
 * across platforms for a given app.
 */
export const appleSocialLoginHandler = makeSocialLoginHandler({
  provider: 'apple',
  jwksUrl: 'https://appleid.apple.com/auth/keys',
  expectedIssuers: ['https://appleid.apple.com'],
  resolveAudiences: () =>
    env.APPLE_SIGN_IN_SERVICE_ID !== undefined ? [env.APPLE_SIGN_IN_SERVICE_ID] : [],
});
