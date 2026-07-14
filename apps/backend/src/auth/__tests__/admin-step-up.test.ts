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

  describe('CF-08 scope claim', () => {
    it('defaults to the wildcard scope when none is supplied', () => {
      const { token, claims } = signAdminStepUpToken({ sub: 'a', email: 'a@b.c' });
      expect(claims.scope).toBe('admin-write');
      const verified = verifyAdminStepUpToken(token);
      expect(verified.ok).toBe(true);
      if (verified.ok) expect(verified.claims.scope).toBe('admin-write');
    });

    it('round-trips a narrowed scope', () => {
      const { token, claims } = signAdminStepUpToken({
        sub: 'a',
        email: 'a@b.c',
        scope: 'withdrawal',
      });
      expect(claims.scope).toBe('withdrawal');
      const verified = verifyAdminStepUpToken(token);
      expect(verified.ok).toBe(true);
      if (verified.ok) expect(verified.claims.scope).toBe('withdrawal');
    });

    it('treats a scope-less wire token as the wildcard (backward-safe rotation)', () => {
      // A token minted before the `scope` claim existed has no `scope`
      // field on the wire — it must verify as the wildcard so an
      // in-flight token survives the upgrade window.
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
        'base64url',
      );
      const payload = Buffer.from(
        JSON.stringify({
          sub: 'a',
          email: 'a@b.c',
          purpose: 'admin-step-up',
          aud: 'admin-write',
          iss: 'loop-api',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 60,
          // no `scope`
        }),
      ).toString('base64url');
      const sig = createHmac('sha256', TEST_KEY).update(`${header}.${payload}`).digest('base64url');
      const verified = verifyAdminStepUpToken(`${header}.${payload}.${sig}`);
      expect(verified.ok).toBe(true);
      if (verified.ok) expect(verified.claims.scope).toBe('admin-write');
    });

    it('rejects an unknown scope as malformed (not a silent wildcard)', () => {
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
        'base64url',
      );
      const payload = Buffer.from(
        JSON.stringify({
          sub: 'a',
          email: 'a@b.c',
          purpose: 'admin-step-up',
          aud: 'admin-write',
          iss: 'loop-api',
          scope: 'not-a-real-scope', // ← unknown
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 60,
        }),
      ).toString('base64url');
      const sig = createHmac('sha256', TEST_KEY).update(`${header}.${payload}`).digest('base64url');
      const verified = verifyAdminStepUpToken(`${header}.${payload}.${sig}`);
      expect(verified.ok).toBe(false);
      if (!verified.ok) expect(verified.reason).toBe('malformed');
    });
  });

  describe('SEC-02-stepup jti claim (single-use key)', () => {
    it('stamps a fresh v4 uuid jti on every mint, and round-trips it', () => {
      const a = signAdminStepUpToken({ sub: 'a', email: 'a@b.c', scope: 'refund' });
      const b = signAdminStepUpToken({ sub: 'a', email: 'a@b.c', scope: 'refund' });
      expect(a.claims.jti).toMatch(/^[0-9a-f-]{36}$/);
      // Two mints get DISTINCT jtis — this is what makes each token a
      // single, independently-consumable use.
      expect(a.claims.jti).not.toBe(b.claims.jti);
      const verified = verifyAdminStepUpToken(a.token);
      expect(verified.ok).toBe(true);
      if (verified.ok) expect(verified.claims.jti).toBe(a.claims.jti);
    });

    it('honours a pinned jti override (for single-use test assertions)', () => {
      const { token, claims } = signAdminStepUpToken({
        sub: 'a',
        email: 'a@b.c',
        scope: 'refund',
        jti: 'fixed-jti-1',
      });
      expect(claims.jti).toBe('fixed-jti-1');
      const verified = verifyAdminStepUpToken(token);
      if (verified.ok) expect(verified.claims.jti).toBe('fixed-jti-1');
    });

    it('verifies a jti-less wire token with jti undefined (backward-safe rotation)', () => {
      // A token minted before the `jti` claim existed has no `jti` field.
      // It must still VERIFY (so an in-flight token survives the upgrade
      // window) — but the consume path fails it closed (not_consumable),
      // covered in the DB-backed consume suite.
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
        'base64url',
      );
      const payload = Buffer.from(
        JSON.stringify({
          sub: 'a',
          email: 'a@b.c',
          purpose: 'admin-step-up',
          aud: 'admin-write',
          iss: 'loop-api',
          scope: 'refund',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 60,
          // no `jti`
        }),
      ).toString('base64url');
      const sig = createHmac('sha256', TEST_KEY).update(`${header}.${payload}`).digest('base64url');
      const verified = verifyAdminStepUpToken(`${header}.${payload}.${sig}`);
      expect(verified.ok).toBe(true);
      if (verified.ok) expect(verified.claims.jti).toBeUndefined();
    });

    it('rejects a present-but-empty / non-string jti as malformed (not a silent unlimited-use token)', () => {
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
        'base64url',
      );
      const mk = (jti: unknown): string => {
        const payload = Buffer.from(
          JSON.stringify({
            sub: 'a',
            email: 'a@b.c',
            purpose: 'admin-step-up',
            aud: 'admin-write',
            iss: 'loop-api',
            scope: 'refund',
            jti,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 60,
          }),
        ).toString('base64url');
        const sig = createHmac('sha256', TEST_KEY)
          .update(`${header}.${payload}`)
          .digest('base64url');
        return `${header}.${payload}.${sig}`;
      };
      expect(verifyAdminStepUpToken(mk('')).ok).toBe(false);
      expect(verifyAdminStepUpToken(mk(123)).ok).toBe(false);
    });
  });

  // Rotation behaviour (current + previous keys both verify) lives in
  // the shared verify path that mirrors `tokens.ts`'s rotation
  // semantics. Not retested here — exercising rotation needs env.ts
  // to re-capture the env at module-load and the existing pattern in
  // `tokens.ts`'s native test suite already covers that contract.
  // A future test would mock `../../env.js` with a layered key set.
  void TEST_KEY_PREVIOUS; // retained as documentation
});
