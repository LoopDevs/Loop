/**
 * Admin step-up tokens (ADR 028 / CF-08 / SEC-02-stepup).
 *
 * The stateless half (`verifyAdminStepUpToken`) and the authoritative
 * half (`consumeAdminStepUpToken`) are tested separately, because the
 * whole point of SEC-02-stepup is that they disagree: a token can
 * verify perfectly and still be refused because it was minted for a
 * different action class or has already been spent.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type * as ConfigModule from '../../config/index.js';

const KEY = 'admin-step-up-unit-test-key-32-chars!';
const OLD_KEY = 'admin-step-up-unit-test-PREVIOUS-key!';

const { stepUpState } = vi.hoisted(() => ({
  stepUpState: {
    signingKey: undefined as string | undefined,
    previousSigningKey: undefined as string | undefined,
  },
}));

vi.mock('../../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    get config() {
      return { ...actual.config, admin: { ...actual.config.admin, stepUp: stepUpState } };
    },
  };
});

import { db, __resetDbForTests } from '../../db/client.js';
import {
  consumeAdminStepUpToken,
  isAdminStepUpConfigured,
  purgeExpiredAdminStepUpConsumptions,
  signAdminStepUpToken,
  verifyAdminStepUpToken,
} from '../admin-step-up.js';

beforeEach(() => {
  __resetDbForTests();
  stepUpState.signingKey = KEY;
  stepUpState.previousSigningKey = undefined;
});

function mint(overrides: Parameters<typeof signAdminStepUpToken>[0]): string {
  return signAdminStepUpToken(overrides).token;
}

describe('configuration', () => {
  it('reports unconfigured when no signing key is set, and verify fails closed', () => {
    const token = mint({ sub: 'a', email: 'a@b.c', scope: 'staff-role-grant' });
    stepUpState.signingKey = undefined;

    expect(isAdminStepUpConfigured()).toBe(false);
    // `not_configured`, not `bad_signature` — the gate maps this to a
    // 503 so the surface ships disabled rather than silently skipping.
    expect(verifyAdminStepUpToken(token)).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('accepts a token signed with the PREVIOUS key so a rotation overlaps', () => {
    stepUpState.signingKey = OLD_KEY;
    const token = mint({ sub: 'a', email: 'a@b.c', scope: 'staff-role-grant' });
    stepUpState.signingKey = KEY;
    stepUpState.previousSigningKey = OLD_KEY;

    const result = verifyAdminStepUpToken(token);
    expect(result.ok).toBe(true);
  });
});

describe('verifyAdminStepUpToken', () => {
  it('round-trips the claims it was minted with', () => {
    const token = mint({ sub: 'admin-1', email: 'a@b.c', scope: 'staff-role-revoke' });
    const result = verifyAdminStepUpToken(token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims).toMatchObject({
      sub: 'admin-1',
      email: 'a@b.c',
      scope: 'staff-role-revoke',
      purpose: 'admin-step-up',
      aud: 'admin-write',
      iss: 'loop-api',
    });
    expect(result.claims.jti).toEqual(expect.any(String));
  });

  it.each([
    ['not three segments', 'a.b'],
    ['empty segment', 'a..c'],
  ])('rejects a malformed token (%s)', (_label, token) => {
    expect(verifyAdminStepUpToken(token)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a tampered signature', () => {
    const token = mint({ sub: 'a', email: 'a@b.c', scope: 'staff-role-grant' });
    const [h, p] = token.split('.');
    expect(verifyAdminStepUpToken(`${h}.${p}.AAAA`)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects an expired token', () => {
    const token = mint({
      sub: 'a',
      email: 'a@b.c',
      scope: 'staff-role-grant',
      now: Math.floor(Date.now() / 1000) - 3600,
      ttlSeconds: 60,
    });
    expect(verifyAdminStepUpToken(token)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects an unknown scope as malformed rather than reading it as the wildcard', async () => {
    // A silent wildcard fallback here would turn a typo'd — or
    // forged — scope into an all-class token. Sign the forged payload
    // properly so the signature check passes and the scope check is
    // what actually decides.
    const nowSec = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'a',
        email: 'a@b.c',
        purpose: 'admin-step-up',
        aud: 'admin-write',
        iss: 'loop-api',
        scope: 'not-a-real-scope',
        jti: 'x',
        iat: nowSec,
        exp: nowSec + 300,
      }),
    ).toString('base64url');
    const { createHmac } = await import('node:crypto');
    const sig = createHmac('sha256', KEY).update(`${header}.${payload}`).digest('base64url');

    expect(verifyAdminStepUpToken(`${header}.${payload}.${sig}`)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('consumeAdminStepUpToken', () => {
  it('accepts a token minted for exactly this action, once', async () => {
    const token = mint({ sub: 'a', email: 'a@b.c', scope: 'staff-role-grant' });

    const first = await consumeAdminStepUpToken({ token, action: 'staff-role-grant' });
    expect(first.ok).toBe(true);

    // SINGLE-USE: the replay collides on the recorded `jti`.
    const second = await consumeAdminStepUpToken({ token, action: 'staff-role-grant' });
    expect(second).toEqual({ ok: false, reason: 'already_consumed' });
  });

  it('refuses a token minted for a DIFFERENT action class', async () => {
    const token = mint({ sub: 'a', email: 'a@b.c', scope: 'staff-role-grant' });
    const result = await consumeAdminStepUpToken({ token, action: 'staff-role-revoke' });
    expect(result).toEqual({ ok: false, reason: 'scope_mismatch' });
  });

  it('burns nothing on a scope mismatch, so the token still works on its own class', async () => {
    const token = mint({ sub: 'a', email: 'a@b.c', scope: 'staff-role-grant' });
    await consumeAdminStepUpToken({ token, action: 'staff-role-revoke' });

    const onOwnClass = await consumeAdminStepUpToken({ token, action: 'staff-role-grant' });
    expect(onOwnClass.ok).toBe(true);
  });

  it('refuses the WILDCARD scope against a concrete action — the audited all-class hole', async () => {
    const token = mint({ sub: 'a', email: 'a@b.c' }); // defaults to the wildcard
    const result = await consumeAdminStepUpToken({ token, action: 'staff-role-grant' });
    expect(result).toEqual({ ok: false, reason: 'scope_mismatch' });
  });

  it('fails a jti-less token closed rather than treating it as unlimited-use', async () => {
    // A token from before the claim existed: verifiable, but not
    // trackable, so it must not be spendable.
    const nowSec = Math.floor(Date.now() / 1000);
    const claims = {
      sub: 'a',
      email: 'a@b.c',
      purpose: 'admin-step-up',
      aud: 'admin-write',
      iss: 'loop-api',
      scope: 'staff-role-grant',
      iat: nowSec,
      exp: nowSec + 300,
    };
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const { createHmac } = await import('node:crypto');
    const sig = createHmac('sha256', KEY).update(`${header}.${payload}`).digest('base64url');
    const token = `${header}.${payload}.${sig}`;

    expect(verifyAdminStepUpToken(token).ok).toBe(true);
    expect(await consumeAdminStepUpToken({ token, action: 'staff-role-grant' })).toEqual({
      ok: false,
      reason: 'not_consumable',
    });
  });

  it('serialises a concurrent double-spend to exactly one winner', async () => {
    const token = mint({ sub: 'a', email: 'a@b.c', scope: 'staff-role-grant' });
    const [a, b] = await Promise.all([
      consumeAdminStepUpToken({ token, action: 'staff-role-grant' }),
      consumeAdminStepUpToken({ token, action: 'staff-role-grant' }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });
});

describe('purgeExpiredAdminStepUpConsumptions', () => {
  it('drops markers whose token expired past the retention window, keeping fresh ones', async () => {
    const fresh = mint({ sub: 'a', email: 'a@b.c', scope: 'staff-role-grant' });
    await consumeAdminStepUpToken({ token: fresh, action: 'staff-role-grant' });
    await db.collection('admin_step_up_consumptions').insertOne({
      jti: 'ancient',
      sub: 'a',
      scope: 'staff-role-grant',
      expiresAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      consumedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    });

    const deleted = await purgeExpiredAdminStepUpConsumptions({
      retentionMs: 24 * 60 * 60 * 1000,
    });

    expect(deleted).toBe(1);
    expect(await db.collection('admin_step_up_consumptions').count()).toBe(1);
  });
});
