import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import type * as ConfigModule from '../../config/index.js';
import { createHmac } from 'node:crypto';

const { jwtState } = vi.hoisted(() => ({
  jwtState: {
    current: 'jwt-test-signing-key-32-chars-min!!' as string | undefined,
    previous: undefined as string | undefined,
  },
}));

vi.mock('../../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    get config() {
      return {
        ...actual.config,
        auth: {
          ...actual.config.auth,
          native: { ...actual.config.auth.native, enabled: true, jwt: jwtState },
        },
      };
    },
  };
});

import {
  signLoopToken,
  verifyLoopToken,
  isLoopAuthConfigured,
  DEFAULT_ACCESS_TTL_SECONDS,
  DEFAULT_REFRESH_TTL_SECONDS,
} from '../tokens.js';

const nowSec = 1_800_000_000;

describe('signLoopToken', () => {
  it('emits a three-part HS256 token with the claimed type', () => {
    const { token, claims } = signLoopToken({
      sub: 'u1',
      email: 'a@b.com',
      typ: 'access',
      ttlSeconds: DEFAULT_ACCESS_TTL_SECONDS,
      now: nowSec,
    });
    expect(token.split('.')).toHaveLength(3);
    expect(claims.sub).toBe('u1');
    expect(claims.email).toBe('a@b.com');
    expect(claims.typ).toBe('access');
    expect(claims.iat).toBe(nowSec);
    expect(claims.exp).toBe(nowSec + DEFAULT_ACCESS_TTL_SECONDS);
    expect(claims.jti).toBeUndefined();
  });

  it('generates a jti for refresh tokens', () => {
    const { claims } = signLoopToken({
      sub: 'u1',
      email: 'a@b.com',
      typ: 'refresh',
      ttlSeconds: DEFAULT_REFRESH_TTL_SECONDS,
      now: nowSec,
    });
    expect(typeof claims.jti).toBe('string');
    expect(claims.jti!.length).toBeGreaterThanOrEqual(16);
  });

  it('respects an explicit jti override', () => {
    const { claims } = signLoopToken({
      sub: 'u1',
      email: 'a@b.com',
      typ: 'refresh',
      ttlSeconds: 60,
      now: nowSec,
      jti: 'forced-id',
    });
    expect(claims.jti).toBe('forced-id');
  });
});

describe('verifyLoopToken', () => {
  it('round-trips a freshly-signed access token', () => {
    const { token } = signLoopToken({
      sub: 'u1',
      email: 'a@b.com',
      typ: 'access',
      ttlSeconds: 300,
    });
    const result = verifyLoopToken(token, 'access');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe('u1');
      expect(result.claims.typ).toBe('access');
    }
  });

  it('rejects a token with a bad signature', () => {
    const { token } = signLoopToken({
      sub: 'u1',
      email: 'a@b.com',
      typ: 'access',
      ttlSeconds: 300,
    });
    const [h, p] = token.split('.');
    const tampered = `${h}.${p}.YmFkLXNpZw`;
    const result = verifyLoopToken(tampered, 'access');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rejects a malformed token', () => {
    for (const bad of ['not-a-jwt', 'a.b', 'a.b.c.d', 'a..c']) {
      const r = verifyLoopToken(bad, 'access');
      expect(r.ok).toBe(false);
    }
  });

  it('rejects a token whose payload is not a JSON object', () => {
    const { token } = signLoopToken({
      sub: 'u1',
      email: 'a@b.com',
      typ: 'access',
      ttlSeconds: 300,
    });
    const [h, , s] = token.split('.');
    const badPayload = Buffer.from('not-json').toString('base64url');
    const r = verifyLoopToken(`${h}.${badPayload}.${s}`, 'access');
    expect(r.ok).toBe(false);
  });

  it('rejects a token of the wrong type', () => {
    const { token } = signLoopToken({
      sub: 'u1',
      email: 'a@b.com',
      typ: 'refresh',
      ttlSeconds: 300,
    });
    const result = verifyLoopToken(token, 'access');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong_type');
  });

  it('rejects an expired token', () => {
    const pastNow = Math.floor(Date.now() / 1000) - 10_000;
    const { token } = signLoopToken({
      sub: 'u1',
      email: 'a@b.com',
      typ: 'access',
      ttlSeconds: 60,
      now: pastNow,
    });
    const result = verifyLoopToken(token, 'access');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('A2-1600: signs iss=loop-api and aud=loop-clients on both types', () => {
    const { claims: access } = signLoopToken({
      sub: 'u1',
      email: 'a@b.com',
      typ: 'access',
      ttlSeconds: 300,
    });
    const { claims: refresh } = signLoopToken({
      sub: 'u1',
      email: 'a@b.com',
      typ: 'refresh',
      ttlSeconds: 300,
    });
    expect(access.iss).toBe('loop-api');
    expect(access.aud).toBe('loop-clients');
    expect(refresh.iss).toBe('loop-api');
    expect(refresh.aud).toBe('loop-clients');
  });

  it('A2-1600: rejects a token signed with the correct key but a foreign iss claim', () => {
    const { token } = signLoopToken({
      sub: 'u1',
      email: 'a@b.com',
      typ: 'access',
      ttlSeconds: 300,
    });
    const [h, p, s] = token.split('.');
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    payload['iss'] = 'not-loop-api';
    const newP = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const result = verifyLoopToken(`${h}.${newP}.${s}`, 'access');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(['bad_signature', 'wrong_issuer']).toContain(result.reason);
    }
  });

  it("rejects a token with alg='none' (defence against the classic JWT alg-strip attack)", () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'u1',
        email: 'a@b.com',
        typ: 'access',
        iat: nowSec,
        exp: nowSec + 60,
        iss: 'loop-api',
        aud: 'loop-clients',
      }),
    ).toString('base64url');
    const forged = `${header}.${payload}.`;
    const result = verifyLoopToken(forged, 'access');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed');
  });

  it("rejects a token with alg='none' even if it carries a forged signature", () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'u1',
        email: 'a@b.com',
        typ: 'access',
        iat: nowSec,
        exp: nowSec + 60,
        iss: 'loop-api',
        aud: 'loop-clients',
      }),
    ).toString('base64url');
    const sig = Buffer.alloc(32, 0x00).toString('base64url');
    const forged = `${header}.${payload}.${sig}`;
    const result = verifyLoopToken(forged, 'access');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rejects a token with an unknown alg (e.g. ES256, future RS512)', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'u1',
        email: 'a@b.com',
        typ: 'access',
        iat: nowSec,
        exp: nowSec + 60,
        iss: 'loop-api',
        aud: 'loop-clients',
      }),
    ).toString('base64url');
    const sig = Buffer.alloc(32, 0x42).toString('base64url');
    const forged = `${header}.${payload}.${sig}`;
    const result = verifyLoopToken(forged, 'access');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('A2-1600: malformed when a legacy token without iss/aud is verified', () => {
    const key = jwtState.current!;
    const legacyPayload = {
      sub: 'u1',
      email: 'a@b.com',
      typ: 'access',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    };
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(legacyPayload)).toString('base64url');
    const signingInput = `${header}.${payload}`;
    const sig = createHmac('sha256', key).update(signingInput).digest().toString('base64url');
    const legacyToken = `${signingInput}.${sig}`;
    const result = verifyLoopToken(legacyToken, 'access');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed');
  });

  it('accepts a token signed under the previous key during rotation', async () => {
    const { token } = signLoopToken({
      sub: 'u1',
      email: 'a@b.com',
      typ: 'access',
      ttlSeconds: 300,
    });
    vi.resetModules();
    jwtState.previous = 'jwt-test-signing-key-32-chars-min!!';
    jwtState.current = 'jwt-test-key-n-variant-32-chars-min!';
    const fresh = await import('../tokens.js');
    const result = fresh.verifyLoopToken(token, 'access');
    expect(result.ok).toBe(true);
    jwtState.current = 'jwt-test-signing-key-32-chars-min!!';
    jwtState.previous = undefined;
    vi.resetModules();
  });
});

describe('wire-format back-compat (Track A.1 regression gate)', () => {
  // CF2-17: signature recomputed due to entropy check; header/payload unchanged
  const FIXTURE_TOKEN =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmaXh0dXJlLXVzZXIiLCJlbWFpbCI6ImZpeHR1cmVAbG9vcGZpbmFuY2UudGVzdCIsInR5cCI6ImFjY2VzcyIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjo0MTAyNDQ0ODAwLCJpc3MiOiJsb29wLWFwaSIsImF1ZCI6Imxvb3AtY2xpZW50cyJ9.iI6PPy0lVt72yrig7AO0JB_IQjAU1jgvutGvO6Fdohs';

  it('verifies a pre-refactor-format HS256 token byte-for-byte', () => {
    const result = verifyLoopToken(FIXTURE_TOKEN, 'access');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe('fixture-user');
      expect(result.claims.email).toBe('fixture@loopfinance.test');
      expect(result.claims.typ).toBe('access');
      expect(result.claims.iss).toBe('loop-api');
      expect(result.claims.aud).toBe('loop-clients');
      expect(result.claims.iat).toBe(1_700_000_000);
      expect(result.claims.exp).toBe(4_102_444_800);
    }
  });

  it('the new sign path produces wire-identical output to the pre-refactor algorithm', () => {
    const { token } = signLoopToken({
      sub: 'fixture-user',
      email: 'fixture@loopfinance.test',
      typ: 'access',
      ttlSeconds: 4_102_444_800 - 1_700_000_000,
      now: 1_700_000_000,
    });
    expect(token).toBe(FIXTURE_TOKEN);
  });
});

describe('isLoopAuthConfigured', () => {
  it('reports configured when the signing key is present', () => {
    expect(isLoopAuthConfigured()).toBe(true);
  });
});

afterEach(() => {
  jwtState.current = 'jwt-test-signing-key-32-chars-min!!';
  jwtState.previous = undefined;
});

beforeAll(() => {
  expect(isLoopAuthConfigured()).toBe(true);
});
