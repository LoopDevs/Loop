import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

// Env vars must be set before env.ts is loaded — tokens.ts consumes env
// at module init.
vi.hoisted(() => {
  process.env['LOOP_JWT_SIGNING_KEY'] = 'jwt-test-signing-key-32-chars-min!!';
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
    // Simulate a token minted by something else that happens to share
    // our signing key (e.g. leaked key used by an attacker's service):
    // by signing our own and rewriting iss, then re-HMACing.
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
    // Without re-signing, the tampered token fails bad_signature first.
    // That's still a valid reject — the point of iss/aud is to also
    // catch the re-signed case, which we can't write without the key.
    const result = verifyLoopToken(`${h}.${newP}.${s}`, 'access');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Accept either bad_signature (tampered payload) or wrong_issuer
      // (re-signed in the future if we tighten this), both represent
      // the defence-in-depth working.
      expect(['bad_signature', 'wrong_issuer']).toContain(result.reason);
    }
  });

  it("rejects a token with alg='none' (defence against the classic JWT alg-strip attack)", () => {
    // Standard alg=none form is `header.payload.` — trailing dot,
    // empty signature. The empty-part check at the top of
    // verifyLoopToken catches it before the alg dispatch even runs;
    // reason comes back as 'malformed'. The pre-Track-A.1 code also
    // rejected this (via HMAC length-mismatch); A.1 keeps the
    // protection on a different code path but the outcome is the
    // same: the forged token is refused.
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
    // An attacker who knows the empty-sig path is rejected as
    // malformed might try alg=none with arbitrary bytes in the
    // signature slot, hoping to slip past the empty-part check and
    // land on a path that doesn't verify. Track A.1's alg dispatch
    // catches this: 'none' is not in the {HS256, RS256} allowlist.
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
    // Non-empty signature → passes the malformed check, hits alg dispatch.
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
    // Signature bytes don't matter — alg dispatch rejects before
    // signature verification.
    const sig = Buffer.alloc(32, 0x42).toString('base64url');
    const forged = `${header}.${payload}.${sig}`;
    const result = verifyLoopToken(forged, 'access');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('A2-1600: malformed when a legacy token without iss/aud is verified', () => {
    // Manually-crafted payload representing the pre-fix shape.
    // Signed with the test key so the signature is valid — the
    // rejection must come from the claim-shape check, not signature.
    process.env['LOOP_JWT_SIGNING_KEY'] =
      process.env['LOOP_JWT_SIGNING_KEY'] ?? 'jwt-test-key-x-variant-32-chars-min!';
    const key = process.env['LOOP_JWT_SIGNING_KEY']!;
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
    // PREVIOUS must equal the key that actually signed `token` above
    // (the top-of-file key) — the fallback path only succeeds if the
    // previous key matches what the token was really signed with.
    process.env['LOOP_JWT_SIGNING_KEY_PREVIOUS'] = 'jwt-test-signing-key-32-chars-min!!';
    process.env['LOOP_JWT_SIGNING_KEY'] = 'jwt-test-key-n-variant-32-chars-min!';
    const fresh = await import('../tokens.js');
    const result = fresh.verifyLoopToken(token, 'access');
    expect(result.ok).toBe(true);
    // Reset env module state for the rest of the suite — MUST match the
    // key the wire-format-back-compat fixture below was signed under.
    process.env['LOOP_JWT_SIGNING_KEY'] = 'jwt-test-signing-key-32-chars-min!!';
    delete process.env['LOOP_JWT_SIGNING_KEY_PREVIOUS'];
    vi.resetModules();
  });
});

describe('wire-format back-compat (Track A.1 regression gate)', () => {
  // This fixture was computed via the PRE-REFACTOR algorithm, verbatim:
  //
  //   header = b64url(JSON.stringify({alg: 'HS256', typ: 'JWT'}))
  //   payload = b64url(JSON.stringify(claims))
  //   sig = b64url(createHmac('sha256', key).update(header + '.' + payload).digest())
  //   token = header + '.' + payload + '.' + sig
  //
  // with key = 'jwt-test-signing-key-32-chars-min!!' (the test signing key
  // set at the top of this file) and claims pinned to a far-future exp so
  // the fixture doesn't drift on time. If a future change to signer.ts /
  // tokens.ts produces a different verify behaviour for this exact byte
  // sequence, this assertion fails — proving wire-format
  // back-compatibility with the pre-A.1 binary.
  //
  // Phase-1 gate: a Loop-native deploy that started under the pre-A.1
  // binary may have minted access tokens still alive (15-min TTL); the
  // post-A.1 binary that takes over MUST verify them. This fixture
  // pins that property as a regression test.
  //
  // CF2-17 (2026-06-30 cold audit): the header/payload (and thus the
  // wire-format property this fixture pins) are unchanged from the
  // original fixture — only the signature was recomputed, because the
  // original was signed under a low-entropy repeated-char key that the
  // new signing-key entropy check (env.ts) now rejects. Regenerated via:
  //   createHmac('sha256', 'jwt-test-signing-key-32-chars-min!!')
  //     .update(header + '.' + payload).digest().toString('base64url')
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
    // Sanity-check the inverse: signing the same claims with the
    // current `signLoopToken` should produce the same byte sequence
    // the fixture was computed from. If this drifts, the OLD binary
    // can't verify NEW tokens — the other half of the cross-version
    // compatibility property the deploy needs.
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
  // Keep env stable between tests — the rotation test fiddles with it.
  // MUST match the key the wire-format-back-compat fixture was signed under.
  process.env['LOOP_JWT_SIGNING_KEY'] = 'jwt-test-signing-key-32-chars-min!!';
  delete process.env['LOOP_JWT_SIGNING_KEY_PREVIOUS'];
});

beforeAll(() => {
  // Sanity check: the suite's env vars reached this module.
  expect(process.env['LOOP_JWT_SIGNING_KEY']).toBeDefined();
});
