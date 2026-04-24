import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

// env.ts snapshots at module load — set everything up-front.
vi.hoisted(() => {
  process.env['LOOP_AUTH_NATIVE_ENABLED'] = 'true';
  process.env['LOOP_JWT_SIGNING_KEY'] = 'k'.repeat(32);
  process.env['GOOGLE_OAUTH_CLIENT_ID_WEB'] = 'google-web-client';
  process.env['GOOGLE_OAUTH_CLIENT_ID_IOS'] = 'google-ios-client';
  process.env['APPLE_SIGN_IN_SERVICE_ID'] = 'io.loopfinance.app';
});

const verifyMock = vi.fn();
const resolveMock = vi.fn();
const recordRefreshMock = vi.fn();
const consumeIdTokenMock = vi.fn();

vi.mock('../id-token.js', () => ({
  verifyIdToken: (args: unknown) => verifyMock(args),
}));
// A2-566: social handler one-shot-consumes the id_token after verify.
// Default happy-path returns `true` (first use); replay-test cases
// override to `false` to exercise the rejection path.
vi.mock('../id-token-replay.js', () => ({
  consumeIdToken: (args: unknown) => consumeIdTokenMock(args),
}));
vi.mock('../identities.js', () => ({
  resolveOrCreateUserForIdentity: (args: unknown) => resolveMock(args),
}));
vi.mock('../refresh-tokens.js', () => ({
  recordRefreshToken: (args: unknown) => recordRefreshMock(args),
}));
vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import {
  googleSocialLoginHandler,
  appleSocialLoginHandler,
  makeSocialLoginHandler,
} from '../social.js';

function makeCtx(body: unknown): Context {
  return {
    req: {
      json: async () => {
        if (body === '__throw__') throw new Error('bad json');
        return body;
      },
    },
    get: () => undefined,
    json: (b: unknown, status?: number) =>
      new Response(JSON.stringify(b), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  verifyMock.mockReset();
  resolveMock.mockReset();
  recordRefreshMock.mockReset();
  recordRefreshMock.mockResolvedValue(undefined);
  consumeIdTokenMock.mockReset();
  // Default: id_token is fresh. A2-566 tests override to false.
  consumeIdTokenMock.mockResolvedValue(true);
});

describe('googleSocialLoginHandler', () => {
  it('400 on invalid body', async () => {
    const res = await googleSocialLoginHandler(makeCtx({ notAnIdToken: true }));
    expect(res.status).toBe(400);
  });

  it('401 on a rejected id_token', async () => {
    verifyMock.mockResolvedValue({ ok: false, reason: 'bad_signature' });
    const res = await googleSocialLoginHandler(makeCtx({ idToken: 'x.y.z' }));
    expect(res.status).toBe(401);
  });

  it('401 when the token has no email claim', async () => {
    verifyMock.mockResolvedValue({
      ok: true,
      claims: { iss: 'https://accounts.google.com', aud: 'x', sub: 's', exp: 1, iat: 1 },
    });
    const res = await googleSocialLoginHandler(makeCtx({ idToken: 'x.y.z' }));
    expect(res.status).toBe(401);
  });

  it('401 when email_verified is false', async () => {
    verifyMock.mockResolvedValue({
      ok: true,
      claims: {
        iss: 'https://accounts.google.com',
        aud: 'x',
        sub: 's',
        email: 'a@b.com',
        email_verified: false,
        exp: 1,
        iat: 1,
      },
    });
    const res = await googleSocialLoginHandler(makeCtx({ idToken: 'x.y.z' }));
    expect(res.status).toBe(401);
  });

  it('happy path: verifies, resolves, mints a token pair', async () => {
    verifyMock.mockResolvedValue({
      ok: true,
      claims: {
        iss: 'https://accounts.google.com',
        aud: 'google-web-client',
        sub: 'google-sub-1',
        email: 'a@b.com',
        email_verified: true,
        exp: 1,
        iat: 1,
      },
    });
    resolveMock.mockResolvedValue({
      user: { id: 'user-uuid', email: 'a@b.com', isAdmin: false },
      created: false,
    });
    const res = await googleSocialLoginHandler(makeCtx({ idToken: 'x.y.z' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accessToken: string; refreshToken: string };
    expect(body.accessToken.split('.')).toHaveLength(3);
    expect(body.refreshToken.split('.')).toHaveLength(3);
    expect(resolveMock).toHaveBeenCalledWith({
      provider: 'google',
      providerSub: 'google-sub-1',
      email: 'a@b.com',
    });
    expect(recordRefreshMock).toHaveBeenCalled();
  });

  it('503 when the JWKS fetch throws', async () => {
    verifyMock.mockRejectedValue(new Error('JWKS fetch 500'));
    const res = await googleSocialLoginHandler(makeCtx({ idToken: 'x.y.z' }));
    expect(res.status).toBe(503);
  });

  // A2-566: one-shot consume. A replayed id_token (already seen) is
  // rejected with the same generic 401 as a verify failure — don't tell
  // the caller it was a replay specifically.
  it('A2-566: 401 when consumeIdToken reports a replay', async () => {
    verifyMock.mockResolvedValue({
      ok: true,
      claims: {
        iss: 'https://accounts.google.com',
        aud: 'google-web-client',
        sub: 'google-sub-replay',
        email: 'a@b.com',
        email_verified: true,
        exp: 9999999999,
        iat: 1,
      },
    });
    consumeIdTokenMock.mockResolvedValue(false);
    const res = await googleSocialLoginHandler(makeCtx({ idToken: 'replay-token' }));
    expect(res.status).toBe(401);
    expect(resolveMock).not.toHaveBeenCalled();
    expect(recordRefreshMock).not.toHaveBeenCalled();
  });

  it('A2-566: 503 when consumeIdToken throws (fail closed on DB blip)', async () => {
    verifyMock.mockResolvedValue({
      ok: true,
      claims: {
        iss: 'https://accounts.google.com',
        aud: 'google-web-client',
        sub: 'google-sub-db',
        email: 'a@b.com',
        email_verified: true,
        exp: 9999999999,
        iat: 1,
      },
    });
    consumeIdTokenMock.mockRejectedValue(new Error('postgres down'));
    const res = await googleSocialLoginHandler(makeCtx({ idToken: 'db-error-token' }));
    expect(res.status).toBe(503);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('accepts Apple email_verified="true" (string) as verified', async () => {
    verifyMock.mockResolvedValue({
      ok: true,
      claims: {
        iss: 'https://appleid.apple.com',
        aud: 'io.loopfinance.app',
        sub: 'apple-sub-1',
        email: 'user@privaterelay.appleid.com',
        email_verified: 'true',
        exp: 1,
        iat: 1,
      },
    });
    resolveMock.mockResolvedValue({
      user: { id: 'user-uuid', email: 'user@privaterelay.appleid.com', isAdmin: false },
      created: true,
    });
    const res = await appleSocialLoginHandler(makeCtx({ idToken: 'x.y.z' }));
    expect(res.status).toBe(200);
  });
});

describe('provider not configured', () => {
  it('returns 404 when the provider has no audiences set', async () => {
    const handler = makeSocialLoginHandler({
      provider: 'google',
      jwksUrl: 'https://example.local/jwks',
      expectedIssuers: ['https://example.local'],
      resolveAudiences: () => [],
    });
    const res = await handler(makeCtx({ idToken: 'x.y.z' }));
    expect(res.status).toBe(404);
  });
});

describe('feature flag off', () => {
  it('returns 404 when LOOP_AUTH_NATIVE_ENABLED is false at module load', async () => {
    const prev = process.env['LOOP_AUTH_NATIVE_ENABLED'];
    process.env['LOOP_AUTH_NATIVE_ENABLED'] = 'false';
    vi.resetModules();
    const fresh = await import('../social.js');
    const res = await fresh.googleSocialLoginHandler(makeCtx({ idToken: 'x.y.z' }));
    expect(res.status).toBe(404);
    process.env['LOOP_AUTH_NATIVE_ENABLED'] = prev;
    vi.resetModules();
  });
});
