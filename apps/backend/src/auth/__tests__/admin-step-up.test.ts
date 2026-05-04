import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';

// Pin the test signing key BEFORE any module load so env.ts captures
// it. Mirrors the pattern in `native.test.ts`.
const TEST_KEY = 'admin-step-up-test-key-32-chars-min!!';
const TEST_KEY_PREVIOUS = 'admin-step-up-rotation-key-32chars!!';

vi.hoisted(() => {
  process.env['LOOP_ADMIN_STEP_UP_SIGNING_KEY'] = 'admin-step-up-test-key-32-chars-min!!';
});

import {
  signAdminStepUpToken,
  verifyAdminStepUpToken,
  isAdminStepUpConfigured,
  ADMIN_STEP_UP_TTL_SECONDS,
} from '../admin-step-up.js';

describe('isAdminStepUpConfigured', () => {
  it('true when the signing key is set', () => {
    expect(isAdminStepUpConfigured()).toBe(true);
  });
});

describe('signAdminStepUpToken / verifyAdminStepUpToken', () => {
  it('round-trips a freshly signed token with the documented TTL', () => {
    const { token, claims } = signAdminStepUpToken({
      sub: 'admin-uuid-1',
      email: 'admin@example.com',
    });
    expect(claims.purpose).toBe('admin-step-up');
    expect(claims.aud).toBe('admin-write');
    expect(claims.iss).toBe('loop-api');
    expect(claims.exp - claims.iat).toBe(ADMIN_STEP_UP_TTL_SECONDS);

    const verified = verifyAdminStepUpToken(token);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims.sub).toBe('admin-uuid-1');
      expect(verified.claims.email).toBe('admin@example.com');
    }
  });

  it('rejects an expired token', () => {
    const fakeNow = Math.floor(Date.now() / 1000) - 10 * 60; // 10 min ago
    const { token } = signAdminStepUpToken({
      sub: 'a',
      email: 'a@b.c',
      now: fakeNow,
      ttlSeconds: 60,
    });
    const verified = verifyAdminStepUpToken(token);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('expired');
  });

  it('rejects a token signed with an unrelated key', () => {
    // Sign manually with a different secret so we don't have to swap
    // the env mid-test.
    const wrongKey = 'unrelated-key-32-chars-minimum!!!!';
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'a',
        email: 'a@b.c',
        purpose: 'admin-step-up',
        aud: 'admin-write',
        iss: 'loop-api',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 60,
      }),
    ).toString('base64url');
    const sig = createHmac('sha256', wrongKey).update(`${header}.${payload}`).digest('base64url');
    const verified = verifyAdminStepUpToken(`${header}.${payload}.${sig}`);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('bad_signature');
  });

  it('rejects a forged purpose claim (access-token replayed as step-up)', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'a',
        email: 'a@b.c',
        purpose: 'access', // ← wrong
        aud: 'admin-write',
        iss: 'loop-api',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 60,
      }),
    ).toString('base64url');
    const sig = createHmac('sha256', TEST_KEY).update(`${header}.${payload}`).digest('base64url');
    const verified = verifyAdminStepUpToken(`${header}.${payload}.${sig}`);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('wrong_purpose');
  });

  it('rejects a token with the wrong audience', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'a',
        email: 'a@b.c',
        purpose: 'admin-step-up',
        aud: 'loop-clients', // ← access-token audience, not step-up
        iss: 'loop-api',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 60,
      }),
    ).toString('base64url');
    const sig = createHmac('sha256', TEST_KEY).update(`${header}.${payload}`).digest('base64url');
    const verified = verifyAdminStepUpToken(`${header}.${payload}.${sig}`);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('wrong_audience');
  });

  it('rejects malformed tokens at every breakage point', () => {
    expect(verifyAdminStepUpToken('not-a-jwt').ok).toBe(false);
    expect(verifyAdminStepUpToken('a.b').ok).toBe(false);
    expect(verifyAdminStepUpToken('').ok).toBe(false);
    expect(verifyAdminStepUpToken('.').ok).toBe(false);
    expect(verifyAdminStepUpToken('a..b').ok).toBe(false);
  });

  // Rotation behaviour (current + previous keys both verify) lives in
  // the shared verify path that mirrors `tokens.ts`'s rotation
  // semantics. Not retested here — exercising rotation needs env.ts
  // to re-capture the env at module-load and the existing pattern in
  // `tokens.ts`'s native test suite already covers that contract.
  // A future test would mock `../../env.js` with a layered key set.
  void TEST_KEY_PREVIOUS; // retained as documentation
});
