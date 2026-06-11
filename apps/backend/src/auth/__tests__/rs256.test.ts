/**
 * ADR 030 Phase A — RS256 signing + JWKS material tests.
 *
 * Kept separate from `signer.test.ts` / `tokens.test.ts` (which pin
 * the HS256 wire format and stay byte-for-byte untouched by Phase A)
 * so the legacy suites keep proving the HS256 path is unchanged.
 *
 * Keys are generated at runtime — never commit a PEM fixture, even a
 * test-only one (gitleaks / secret-scan would rightly flag it).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createHash, createVerify, generateKeyPairSync } from 'node:crypto';
import type * as SignerModule from '../signer.js';
import type * as TokensModule from '../tokens.js';

// Generate once for the whole file — 2048-bit keygen is ~100ms each.
// Module scope (not vi.hoisted) is fine: signer/tokens are only ever
// imported dynamically inside loadWithEnv, after the keys exist.
const gen = (): string =>
  generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
const CURRENT_PEM = gen();
const PREVIOUS_PEM = gen();
const UNRELATED_PEM = gen();

const MANAGED_KEYS = [
  'LOOP_JWT_SIGNING_KEY',
  'LOOP_JWT_SIGNING_KEY_PREVIOUS',
  'LOOP_JWT_RSA_PRIVATE_KEY',
  'LOOP_JWT_RSA_PRIVATE_KEY_PREVIOUS',
] as const;

/**
 * Resets module state, applies exactly the given signing-key env
 * vars, and re-imports signer + tokens so `env.ts` re-parses. This
 * is the documented test-reload pattern (see tokens.test.ts rotation
 * test).
 */
async function loadWithEnv(
  vars: Partial<Record<(typeof MANAGED_KEYS)[number], string>>,
): Promise<typeof SignerModule & typeof TokensModule> {
  vi.resetModules();
  for (const k of MANAGED_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  const signer = await import('../signer.js');
  const tokens = await import('../tokens.js');
  return { ...signer, ...tokens };
}

function decodeHeader(token: string): Record<string, unknown> {
  const [h] = token.split('.');
  return JSON.parse(Buffer.from(h!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** Independent RFC 7638 §3.1 thumbprint over an RSA public JWK. */
function rfc7638Thumbprint(jwk: { e: string; n: string }): string {
  return createHash('sha256')
    .update(JSON.stringify({ e: jwk.e, kty: 'RSA', n: jwk.n }))
    .digest('base64url');
}

beforeEach(() => {
  vi.resetModules();
});

afterAll(() => {
  for (const k of MANAGED_KEYS) delete process.env[k];
  vi.resetModules();
});

describe('getActiveSigner under RS256 config', () => {
  it('prefers RS256 over HS256 when both are configured (cutover semantics)', async () => {
    const mod = await loadWithEnv({
      LOOP_JWT_RSA_PRIVATE_KEY: CURRENT_PEM,
      LOOP_JWT_SIGNING_KEY: 'rs256-test-hs-signing-key-32ch!!',
    });
    const s = mod.getActiveSigner();
    expect(s?.alg).toBe('RS256');
    expect(typeof s?.kid).toBe('string');
    expect(s!.kid!.length).toBeGreaterThan(0);
  });

  it('falls back to HS256 when no RSA key is configured (rollout safety)', async () => {
    const mod = await loadWithEnv({ LOOP_JWT_SIGNING_KEY: 'rs256-test-hs-signing-key-32ch!!' });
    expect(mod.getActiveSigner()?.alg).toBe('HS256');
    expect(mod.getVerifiersForAlg('RS256')).toEqual([]);
  });

  it('reports Loop auth configured with only the RSA key set', async () => {
    const mod = await loadWithEnv({ LOOP_JWT_RSA_PRIVATE_KEY: CURRENT_PEM });
    expect(mod.isLoopAuthConfigured()).toBe(true);
  });
});

describe('RS256 sign/verify roundtrip', () => {
  it('signs a token whose header carries alg=RS256 and the kid, and verifies it', async () => {
    const mod = await loadWithEnv({ LOOP_JWT_RSA_PRIVATE_KEY: CURRENT_PEM });
    const { token, claims } = mod.signLoopToken({
      sub: 'u1',
      email: 'a@b.com',
      typ: 'access',
      ttlSeconds: 300,
    });
    const header = decodeHeader(token);
    expect(header['alg']).toBe('RS256');
    expect(typeof header['kid']).toBe('string');
    expect(header['kid']).toBe(mod.getActiveSigner()?.kid);
    expect(claims.iss).toBe('loop-api');

    const result = mod.verifyLoopToken(token, 'access');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe('u1');
      expect(result.claims.typ).toBe('access');
    }
  });

  it('produces a real RSASSA-PKCS1-v1_5/SHA-256 signature (node createVerify cross-check)', async () => {
    const mod = await loadWithEnv({ LOOP_JWT_RSA_PRIVATE_KEY: CURRENT_PEM });
    const { token } = mod.signLoopToken({
      sub: 'u1',
      email: 'a@b.com',
      typ: 'access',
      ttlSeconds: 300,
    });
    const [h, p, s] = token.split('.');
    const { createPublicKey } = await import('node:crypto');
    const publicKey = createPublicKey(CURRENT_PEM);
    const ok = createVerify('RSA-SHA256')
      .update(`${h}.${p}`)
      .verify(publicKey, Buffer.from(s!, 'base64url'));
    expect(ok).toBe(true);
  });

  it('rejects an RS256 token signed by an unrelated key', async () => {
    const foreign = await loadWithEnv({ LOOP_JWT_RSA_PRIVATE_KEY: UNRELATED_PEM });
    const { token } = foreign.signLoopToken({
      sub: 'u1',
      email: 'a@b.com',
      typ: 'access',
      ttlSeconds: 300,
    });
    const mod = await loadWithEnv({ LOOP_JWT_RSA_PRIVATE_KEY: CURRENT_PEM });
    const result = mod.verifyLoopToken(token, 'access');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('kid is the RFC 7638 SHA-256 thumbprint of the public JWK', async () => {
    const mod = await loadWithEnv({ LOOP_JWT_RSA_PRIVATE_KEY: CURRENT_PEM });
    const jwks = mod.getLoopRsaPublicJwks();
    expect(jwks).toHaveLength(1);
    const jwk = jwks[0]!;
    expect(jwk.kid).toBe(rfc7638Thumbprint(jwk));
    expect(mod.getActiveSigner()?.kid).toBe(jwk.kid);
  });
});

describe('rotation + migration windows', () => {
  it('verifies a token signed under the previous RSA key during rotation', async () => {
    // Mint while PREVIOUS_PEM is the active key…
    const old = await loadWithEnv({ LOOP_JWT_RSA_PRIVATE_KEY: PREVIOUS_PEM });
    const { token } = old.signLoopToken({
      sub: 'u1',
      email: 'a@b.com',
      typ: 'access',
      ttlSeconds: 300,
    });
    // …then rotate: new current key, old key in the PREVIOUS slot.
    const rotated = await loadWithEnv({
      LOOP_JWT_RSA_PRIVATE_KEY: CURRENT_PEM,
      LOOP_JWT_RSA_PRIVATE_KEY_PREVIOUS: PREVIOUS_PEM,
    });
    const result = rotated.verifyLoopToken(token, 'access');
    expect(result.ok).toBe(true);

    // Without the PREVIOUS slot the old token must fail — proving the
    // accept came from the previous-key verifier, not the current.
    const dropped = await loadWithEnv({ LOOP_JWT_RSA_PRIVATE_KEY: CURRENT_PEM });
    expect(dropped.verifyLoopToken(token, 'access').ok).toBe(false);
  });

  it('still verifies a legacy HS256 token during the HS256→RS256 cutover window', async () => {
    // Mint under HS256-only config (the pre-cutover deployment)…
    const legacy = await loadWithEnv({ LOOP_JWT_SIGNING_KEY: 'rs256-test-legacy-signing-key-x1' });
    const { token: hsToken } = legacy.signLoopToken({
      sub: 'u1',
      email: 'a@b.com',
      typ: 'access',
      ttlSeconds: 300,
    });
    expect(decodeHeader(hsToken)['alg']).toBe('HS256');

    // …then cut over: RSA key set, HS256 key retained verify-only.
    const cutover = await loadWithEnv({
      LOOP_JWT_RSA_PRIVATE_KEY: CURRENT_PEM,
      LOOP_JWT_SIGNING_KEY: 'rs256-test-legacy-signing-key-x1',
    });
    const result = cutover.verifyLoopToken(hsToken, 'access');
    expect(result.ok).toBe(true);

    // New tokens mint RS256 from the same deployment.
    const { token: rsToken } = cutover.signLoopToken({
      sub: 'u1',
      email: 'a@b.com',
      typ: 'access',
      ttlSeconds: 300,
    });
    expect(decodeHeader(rsToken)['alg']).toBe('RS256');
    expect(cutover.verifyLoopToken(rsToken, 'access').ok).toBe(true);
  });
});

describe('getLoopRsaPublicJwks', () => {
  it('serves both kids during a rotation window, current first', async () => {
    const mod = await loadWithEnv({
      LOOP_JWT_RSA_PRIVATE_KEY: CURRENT_PEM,
      LOOP_JWT_RSA_PRIVATE_KEY_PREVIOUS: PREVIOUS_PEM,
    });
    const jwks = mod.getLoopRsaPublicJwks();
    expect(jwks).toHaveLength(2);
    expect(jwks[0]!.kid).toBe(mod.getActiveSigner()?.kid);
    expect(jwks[1]!.kid).not.toBe(jwks[0]!.kid);
  });

  it('contains only the six public JWK members — never private material', async () => {
    const mod = await loadWithEnv({
      LOOP_JWT_RSA_PRIVATE_KEY: CURRENT_PEM,
      LOOP_JWT_RSA_PRIVATE_KEY_PREVIOUS: PREVIOUS_PEM,
    });
    for (const jwk of mod.getLoopRsaPublicJwks()) {
      expect(Object.keys(jwk).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
      expect(jwk.kty).toBe('RSA');
      expect(jwk.alg).toBe('RS256');
      expect(jwk.use).toBe('sig');
      const raw = jwk as unknown as Record<string, unknown>;
      for (const priv of ['d', 'p', 'q', 'dp', 'dq', 'qi']) {
        expect(raw[priv]).toBeUndefined();
      }
    }
  });

  it('returns an empty array when RS256 is unconfigured', async () => {
    const mod = await loadWithEnv({ LOOP_JWT_SIGNING_KEY: 'rs256-test-hs-signing-key-32ch!!' });
    expect(mod.getLoopRsaPublicJwks()).toEqual([]);
  });
});
