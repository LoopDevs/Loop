// Social-login handlers — Google + Apple — ADR 014
import type { Context } from 'hono';
import { logger } from '../logger.js';
import { config } from '../config/index.js';
import { verifyIdToken, type VerifyIdTokenResult } from './id-token.js';
import { consumeIdToken } from './id-token-replay.js';
import { resolveOrCreateUserForIdentity } from './identities.js';
import { isLoopAuthConfigured } from './tokens.js';
import { issueTokenPair } from './issue-token-pair.js';
import { enqueueCtxUserProvisioning } from '../ctx/user-provisioning.js';
import type { SocialProvider } from '../db/types.js';
// D1: request body schema matches OpenAPI spec
import { SocialLoginBody as Body } from './social-schemas.js';

const log = logger.child({ handler: 'auth-social' });

export interface SocialProviderConfig {
  provider: SocialProvider;
  jwksUrl: string;
  /** A2-567: Google id_token iss varies by SDK version; accept both scheme and scheme-less forms */
  expectedIssuers: string[];
  resolveAudiences: () => string[];
}

export function makeSocialLoginHandler(providerConfig: SocialProviderConfig) {
  return async function socialLoginHandler(c: Context): Promise<Response> {
    if (!config.auth.native.enabled) {
      return c.json({ code: 'NOT_FOUND', message: 'Not found' }, 404);
    }
    if (!isLoopAuthConfigured()) {
      log.error('LOOP_AUTH_NATIVE_ENABLED without LOOP_JWT_SIGNING_KEY');
      return c.json({ code: 'INTERNAL_ERROR', message: 'Auth not configured' }, 500);
    }
    const audiences = providerConfig.resolveAudiences();
    if (audiences.length === 0) {
      // 404 rather than 401 to prevent probing for live providers
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
        jwksUrl: providerConfig.jwksUrl,
        expectedIssuers: providerConfig.expectedIssuers,
        expectedAudiences: audiences,
      });
    } catch (err) {
      // 503 allows client retry; token may be valid but provider unreachable
      log.error(
        { err, provider: providerConfig.provider },
        'JWKS fetch failed during social verify',
      );
      return c.json(
        { code: 'SERVICE_UNAVAILABLE', message: 'Identity provider temporarily unavailable' },
        503,
      );
    }
    if (!verified.ok) {
      log.warn(
        { reason: verified.reason, provider: providerConfig.provider },
        'Social id_token rejected',
      );
      return c.json({ code: 'UNAUTHORIZED', message: 'Invalid id_token' }, 401);
    }
    const claims = verified.claims;

    // A2-566: one-shot consume; replay rejected with generic 401
    let firstUse: boolean;
    try {
      firstUse = await consumeIdToken({
        token: parsed.data.idToken,
        provider: providerConfig.provider,
        expSeconds: claims.exp,
      });
    } catch {
      // DB error is operational; 503 prevents replay window
      return c.json(
        { code: 'SERVICE_UNAVAILABLE', message: 'Auth service temporarily unavailable' },
        503,
      );
    }
    if (!firstUse) {
      return c.json({ code: 'UNAUTHORIZED', message: 'Invalid id_token' }, 401);
    }

    const email = typeof claims['email'] === 'string' ? claims['email'] : null;
    if (email === null) {
      log.warn({ provider: providerConfig.provider }, 'Social id_token missing email claim');
      return c.json({ code: 'UNAUTHORIZED', message: 'Provider did not share email' }, 401);
    }
    // Apple may emit email_verified as string; coerce both shapes
    const raw = claims['email_verified'] as unknown;
    const emailVerified = raw === true || raw === 'true';
    if (!emailVerified) {
      log.warn({ provider: providerConfig.provider }, 'Social id_token email_verified=false');
      return c.json({ code: 'UNAUTHORIZED', message: 'Email not verified by provider' }, 401);
    }

    try {
      const { user } = await resolveOrCreateUserForIdentity({
        provider: providerConfig.provider,
        providerSub: claims.sub,
        email,
      });
      // NS-09: stamp token_version for revocability
      const pair = await issueTokenPair({
        id: user.id,
        email: user.email,
        tokenVersion: user.tokenVersion,
      });
      enqueueCtxUserProvisioning(user);
      return c.json({
        accessToken: pair.accessToken,
        refreshToken: pair.refreshToken,
        email: user.email,
      });
    } catch (err) {
      log.error({ err, provider: providerConfig.provider }, 'Social login failed unexpectedly');
      return c.json({ code: 'INTERNAL_ERROR', message: 'Social sign-in failed' }, 500);
    }
  };
}

export const googleSocialLoginHandler = makeSocialLoginHandler({
  provider: 'google',
  jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
  // A2-567: scheme-less iss still ships from older SDKs
  expectedIssuers: ['https://accounts.google.com', 'accounts.google.com'],
  resolveAudiences: () =>
    [
      config.auth.social.google.web,
      config.auth.social.google.ios,
      config.auth.social.google.android,
    ].filter((v): v is string => typeof v === 'string' && v.length > 0),
});

export const appleSocialLoginHandler = makeSocialLoginHandler({
  provider: 'apple',
  jwksUrl: 'https://appleid.apple.com/auth/keys',
  expectedIssuers: ['https://appleid.apple.com'],
  resolveAudiences: () =>
    config.auth.social.apple.serviceId !== undefined ? [config.auth.social.apple.serviceId] : [],
});
