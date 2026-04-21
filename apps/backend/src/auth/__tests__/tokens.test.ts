import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';

// Env vars must be set before env.ts is loaded — tokens.ts consumes env
// at module init.
vi.hoisted(() => {
  process.env['LOOP_JWT_SIGNING_KEY'] = 'k'.repeat(32);
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
    // Access tokens have no jti.
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
    // Valid signature over bogus payload is harder to forge than just
    // making the payload not-an-object — any non-JSON here trips
    // malformed before signature check is meaningful. Construct by
    // signing a valid token and replacing its payload.
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

  it('accepts a token signed under the previous key during rotation', async () => {
    // Sign with the current key, then flip current + previous so the
    // token looks "old" and should only verify via the previous-key
    // fallback path.
    const { token } = signLoopToken({
      sub: 'u1',
      email: 'a@b.com',
      typ: 'access',
      ttlSeconds: 300,
    });
    vi.resetModules();
    process.env['LOOP_JWT_SIGNING_KEY_PREVIOUS'] = 'k'.repeat(32);
    process.env['LOOP_JWT_SIGNING_KEY'] = 'n'.repeat(32);
    const fresh = await import('../tokens.js');
    const result = fresh.verifyLoopToken(token, 'access');
    expect(result.ok).toBe(true);
    // Reset env module state for the rest of the suite.
    process.env['LOOP_JWT_SIGNING_KEY'] = 'k'.repeat(32);
    delete process.env['LOOP_JWT_SIGNING_KEY_PREVIOUS'];
    vi.resetModules();
  });
});

describe('isLoopAuthConfigured', () => {
  it('reports configured when the signing key is present', () => {
    expect(isLoopAuthConfigured()).toBe(true);
  });
});

afterEach(() => {
  // Keep env stable between tests — the rotation test fiddles with it.
  process.env['LOOP_JWT_SIGNING_KEY'] = 'k'.repeat(32);
  delete process.env['LOOP_JWT_SIGNING_KEY_PREVIOUS'];
});

beforeAll(() => {
  // Sanity check: the suite's env vars reached this module.
  expect(process.env['LOOP_JWT_SIGNING_KEY']).toBeDefined();
});
