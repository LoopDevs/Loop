import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, createSign, type KeyObject, createPublicKey } from 'node:crypto';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { fetchJwks, verifyIdToken, __resetJwksCacheForTests } from '../id-token.js';

// ─── Test-side signer ────────────────────────────────────────────────────────

interface Keypair {
  publicKey: KeyObject;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function makeKeypair(kid: string): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const exported = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return {
    publicKey,
    privateKey,
    jwk: { ...exported, kid, alg: 'RS256', use: 'sig' },
  };
}

function b64url(s: string | Buffer): string {
  const b = typeof s === 'string' ? Buffer.from(s, 'utf8') : s;
  return b.toString('base64url');
}

function signJwt(args: {
  privateKey: KeyObject;
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}): string {
  const h = b64url(JSON.stringify(args.header));
  const p = b64url(JSON.stringify(args.payload));
  const signingInput = `${h}.${p}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  const sig = b64url(signer.sign(args.privateKey));
  return `${signingInput}.${sig}`;
}

// ─── fetch + JWKS mock harness ───────────────────────────────────────────────

const JWKS_URL = 'https://issuer.example/.well-known/jwks.json';
let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  __resetJwksCacheForTests();
});
afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
});

function stubJwks(keys: Array<Record<string, unknown>>): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
    expect(String(url)).toBe(JWKS_URL);
    return new Response(JSON.stringify({ keys }), { status: 200 });
  });
}

// ─── fetchJwks ────────────────────────────────────────────────────────────────

describe('fetchJwks', () => {
  it('fetches + caches the JWKS (second call is a cache hit)', async () => {
    const kp = makeKeypair('k-1');
    fetchSpy = stubJwks([kp.jwk]);
    const keys1 = await fetchJwks(JWKS_URL);
    const keys2 = await fetchJwks(JWKS_URL);
    expect(keys1).toEqual(keys2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('throws on non-2xx', async () => {
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('nope', { status: 503 }));
    await expect(fetchJwks(JWKS_URL)).rejects.toThrow(/JWKS fetch 503/);
  });

  it('throws on schema drift', async () => {
    fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{"not":"keys"}', { status: 200 }));
    await expect(fetchJwks(JWKS_URL)).rejects.toThrow(/schema drift/);
  });
});

// ─── verifyIdToken happy + reject paths ──────────────────────────────────────

const ISS = 'https://issuer.example';
const AUD = 'loop-web-client';

describe('verifyIdToken', () => {
  it('accepts a valid RS256 token signed by a JWKS key', async () => {
    const kp = makeKeypair('k-live');
    fetchSpy = stubJwks([kp.jwk]);
    const token = signJwt({
      privateKey: kp.privateKey,
      header: { alg: 'RS256', kid: 'k-live', typ: 'JWT' },
      payload: {
        iss: ISS,
        aud: AUD,
        sub: 'provider-sub-1',
        email: 'a@b.com',
        email_verified: true,
        iat: 1_700_000_000,
        exp: 2_000_000_000,
      },
    });
    const result = await verifyIdToken({
      token,
      jwksUrl: JWKS_URL,
      expectedIssuers: [ISS],
      expectedAudiences: [AUD],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe('provider-sub-1');
      expect(result.claims.email).toBe('a@b.com');
    }
  });

  it('rejects a token whose alg is not RS256', async () => {
    const kp = makeKeypair('k-1');
    fetchSpy = stubJwks([kp.jwk]);
    const token = signJwt({
      privateKey: kp.privateKey,
      header: { alg: 'HS256', kid: 'k-1', typ: 'JWT' },
      payload: { iss: ISS, aud: AUD, sub: 's', iat: 1, exp: 2 },
    });
    const r = await verifyIdToken({
      token,
      jwksUrl: JWKS_URL,
      expectedIssuers: [ISS],
      expectedAudiences: [AUD],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unsupported_alg');
  });

  it('rejects malformed tokens (wrong segment count, empty segments)', async () => {
    fetchSpy = stubJwks([]);
    for (const bad of ['a.b', 'not-a-jwt', 'a.b.c.d', 'a..c']) {
      const r = await verifyIdToken({
        token: bad,
        jwksUrl: JWKS_URL,
        expectedIssuers: [ISS],
        expectedAudiences: [AUD],
      });
      expect(r.ok).toBe(false);
    }
  });

  it('rejects a token signed by a different private key (bad signature)', async () => {
    const kp = makeKeypair('k-real');
    const attacker = makeKeypair('k-real'); // same kid, attacker's key
    fetchSpy = stubJwks([kp.jwk]); // but we publish the real one
    const token = signJwt({
      privateKey: attacker.privateKey,
      header: { alg: 'RS256', kid: 'k-real', typ: 'JWT' },
      payload: {
        iss: ISS,
        aud: AUD,
        sub: 's',
        iat: 1_700_000_000,
        exp: 2_000_000_000,
      },
    });
    const r = await verifyIdToken({
      token,
      jwksUrl: JWKS_URL,
      expectedIssuers: [ISS],
      expectedAudiences: [AUD],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_signature');
  });

  it('rejects the wrong issuer', async () => {
    const kp = makeKeypair('k-1');
    fetchSpy = stubJwks([kp.jwk]);
    const token = signJwt({
      privateKey: kp.privateKey,
      header: { alg: 'RS256', kid: 'k-1', typ: 'JWT' },
      payload: { iss: 'https://evil.example', aud: AUD, sub: 's', iat: 1, exp: 2_000_000_000 },
    });
    const r = await verifyIdToken({
      token,
      jwksUrl: JWKS_URL,
      expectedIssuers: [ISS],
      expectedAudiences: [AUD],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('wrong_issuer');
  });

  it('A2-567: accepts ANY of the expectedIssuers (Google emits two variants)', async () => {
    const kp = makeKeypair('k-1');
    fetchSpy = stubJwks([kp.jwk]);
    // Token carries the scheme-LESS variant. Without A2-567 the
    // server would reject on exact-match against the schemed form.
    const token = signJwt({
      privateKey: kp.privateKey,
      header: { alg: 'RS256', kid: 'k-1', typ: 'JWT' },
      payload: {
        iss: 'accounts.google.com',
        aud: AUD,
        sub: 's',
        iat: 1,
        exp: 2_000_000_000,
      },
    });
    const r = await verifyIdToken({
      token,
      jwksUrl: JWKS_URL,
      expectedIssuers: ['https://accounts.google.com', 'accounts.google.com'],
      expectedAudiences: [AUD],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects the wrong audience', async () => {
    const kp = makeKeypair('k-1');
    fetchSpy = stubJwks([kp.jwk]);
    const token = signJwt({
      privateKey: kp.privateKey,
      header: { alg: 'RS256', kid: 'k-1', typ: 'JWT' },
      payload: {
        iss: ISS,
        aud: 'other-client',
        sub: 's',
        iat: 1,
        exp: 2_000_000_000,
      },
    });
    const r = await verifyIdToken({
      token,
      jwksUrl: JWKS_URL,
      expectedIssuers: [ISS],
      expectedAudiences: [AUD],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('wrong_audience');
  });

  it('accepts when audience is one of several acceptable values', async () => {
    const kp = makeKeypair('k-1');
    fetchSpy = stubJwks([kp.jwk]);
    const token = signJwt({
      privateKey: kp.privateKey,
      header: { alg: 'RS256', kid: 'k-1', typ: 'JWT' },
      payload: {
        iss: ISS,
        aud: 'ios-client',
        sub: 's',
        iat: 1,
        exp: 2_000_000_000,
      },
    });
    const r = await verifyIdToken({
      token,
      jwksUrl: JWKS_URL,
      expectedIssuers: [ISS],
      expectedAudiences: ['web-client', 'ios-client', 'android-client'],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects expired tokens', async () => {
    const kp = makeKeypair('k-1');
    fetchSpy = stubJwks([kp.jwk]);
    const token = signJwt({
      privateKey: kp.privateKey,
      header: { alg: 'RS256', kid: 'k-1', typ: 'JWT' },
      payload: { iss: ISS, aud: AUD, sub: 's', iat: 1, exp: 100 },
    });
    const r = await verifyIdToken({
      token,
      jwksUrl: JWKS_URL,
      expectedIssuers: [ISS],
      expectedAudiences: [AUD],
      now: 1_000_000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('expired');
  });

  it('force-refetches JWKS once on unknown kid before giving up', async () => {
    const kp1 = makeKeypair('k-old');
    const kp2 = makeKeypair('k-new');
    // First call returns the old key; second (forced refetch) returns
    // the rotated set including the new key.
    let call = 0;
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call++;
      if (call === 1) return new Response(JSON.stringify({ keys: [kp1.jwk] }), { status: 200 });
      return new Response(JSON.stringify({ keys: [kp1.jwk, kp2.jwk] }), { status: 200 });
    });
    const token = signJwt({
      privateKey: kp2.privateKey,
      header: { alg: 'RS256', kid: 'k-new', typ: 'JWT' },
      payload: {
        iss: ISS,
        aud: AUD,
        sub: 's',
        iat: 1_700_000_000,
        exp: 2_000_000_000,
      },
    });
    const r = await verifyIdToken({
      token,
      jwksUrl: JWKS_URL,
      expectedIssuers: [ISS],
      expectedAudiences: [AUD],
    });
    expect(r.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('gives up with unknown_kid when even the forced refetch misses', async () => {
    const kp = makeKeypair('k-real');
    const attacker = makeKeypair('k-ghost');
    fetchSpy = stubJwks([kp.jwk]);
    const token = signJwt({
      privateKey: attacker.privateKey,
      header: { alg: 'RS256', kid: 'k-ghost', typ: 'JWT' },
      payload: {
        iss: ISS,
        aud: AUD,
        sub: 's',
        iat: 1_700_000_000,
        exp: 2_000_000_000,
      },
    });
    const r = await verifyIdToken({
      token,
      jwksUrl: JWKS_URL,
      expectedIssuers: [ISS],
      expectedAudiences: [AUD],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown_kid');
  });
});

describe('JWK import sanity', () => {
  it('the test helper produces a JWK Node can import as a public key', () => {
    const kp = makeKeypair('k-sanity');
    const key = createPublicKey({ format: 'jwk', key: kp.jwk as Record<string, unknown> });
    expect(key.type).toBe('public');
  });
});
