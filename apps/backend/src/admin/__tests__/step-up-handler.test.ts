import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

/**
 * CF2 (2026-06-30 cold audit) reopens CF-11 (06-15 audit): this handler
 * gates every destructive admin write (credit-adjust, refund, withdrawal,
 * payout-retry, payout-compensation, home-currency per ADR 028) and had
 * ZERO tests, with a stale comment elsewhere claiming it was covered. These
 * pin the handler's mint/verify/expiry/purpose-binding/reuse-prevention
 * invariants at the HTTP-handler layer (the crypto-level mint/verify
 * primitives are separately covered in `auth/__tests__/admin-step-up.test.ts`).
 */

const { findLiveOtpMock, incrementOtpAttemptsMock, markOtpConsumedMock, signMock, configuredMock } =
  vi.hoisted(() => ({
    findLiveOtpMock: vi.fn(),
    incrementOtpAttemptsMock: vi.fn(async () => undefined),
    markOtpConsumedMock: vi.fn(async () => undefined),
    signMock: vi.fn(),
    configuredMock: vi.fn(() => true),
  }));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock('../../auth/otps.js', () => ({
  findLiveOtp: findLiveOtpMock,
  incrementOtpAttempts: incrementOtpAttemptsMock,
  markOtpConsumed: markOtpConsumedMock,
}));

vi.mock('../../auth/admin-step-up.js', () => ({
  isAdminStepUpConfigured: configuredMock,
  signAdminStepUpToken: signMock,
  STEP_UP_SCOPES: [
    'admin-write',
    'credit-adjustment',
    'refund',
    'withdrawal',
    'payout-retry',
    'payout-compensation',
    'home-currency',
  ] as const,
}));

import { adminStepUpHandler } from '../step-up-handler.js';

function makeCtx(opts: {
  auth?: { kind: 'loop' | 'ctx'; userId: string; email: string } | undefined;
  body?: unknown;
}): Context {
  const store = new Map<string, unknown>();
  if (opts.auth !== undefined) store.set('auth', opts.auth);
  return {
    req: {
      json: async () => {
        if (opts.body === '__throw__') throw new Error('bad json');
        return opts.body;
      },
    },
    get: (k: string) => store.get(k),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

const LOOP_ADMIN = { kind: 'loop' as const, userId: 'admin-uuid-1', email: 'admin@loop.test' };

beforeEach(() => {
  findLiveOtpMock.mockReset();
  incrementOtpAttemptsMock.mockReset().mockResolvedValue(undefined);
  markOtpConsumedMock.mockReset().mockResolvedValue(undefined);
  signMock.mockReset().mockReturnValue({
    token: 'signed.step.up',
    claims: { exp: Math.floor(Date.now() / 1000) + 300, scope: 'admin-write' },
  });
  configuredMock.mockReset().mockReturnValue(true);
});

describe('adminStepUpHandler', () => {
  it('503 STEP_UP_UNAVAILABLE when the signing key is not configured', async () => {
    configuredMock.mockReturnValue(false);
    const res = await adminStepUpHandler(makeCtx({ auth: LOOP_ADMIN, body: { otp: '123456' } }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('STEP_UP_UNAVAILABLE');
    // Fails closed before ever touching the OTP store.
    expect(findLiveOtpMock).not.toHaveBeenCalled();
  });

  it('401 UNAUTHORIZED when there is no loop-native auth context', async () => {
    const res = await adminStepUpHandler(makeCtx({ auth: undefined, body: { otp: '123456' } }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('401 UNAUTHORIZED for a CTX-proxy admin (step-up is Loop-native only)', async () => {
    const res = await adminStepUpHandler(
      makeCtx({ auth: { kind: 'ctx', userId: 'x', email: 'a@b.com' }, body: { otp: '123456' } }),
    );
    expect(res.status).toBe(401);
  });

  it('400 VALIDATION_ERROR when otp is missing from the body', async () => {
    const res = await adminStepUpHandler(makeCtx({ auth: LOOP_ADMIN, body: {} }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('400 VALIDATION_ERROR on an unrecognised scope value', async () => {
    const res = await adminStepUpHandler(
      makeCtx({ auth: LOOP_ADMIN, body: { otp: '123456', scope: 'not-a-real-scope' } }),
    );
    expect(res.status).toBe(400);
  });

  it('400 VALIDATION_ERROR when the request body is unparseable JSON', async () => {
    const res = await adminStepUpHandler(makeCtx({ auth: LOOP_ADMIN, body: '__throw__' }));
    expect(res.status).toBe(400);
  });

  it('401 on a wrong/expired OTP, and bumps the attempts counter (reuse/brute-force guard)', async () => {
    findLiveOtpMock.mockResolvedValue(null);
    const res = await adminStepUpHandler(makeCtx({ auth: LOOP_ADMIN, body: { otp: '000000' } }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHORIZED');
    expect(incrementOtpAttemptsMock).toHaveBeenCalledWith({ email: 'admin@loop.test' });
    // A wrong guess must never mint a token or consume anything.
    expect(signMock).not.toHaveBeenCalled();
    expect(markOtpConsumedMock).not.toHaveBeenCalled();
  });

  it('401 UNAUTHORIZED (same shape as a wrong OTP) for a non-ASCII stored email, without leaking the reason', async () => {
    const res = await adminStepUpHandler(
      makeCtx({
        auth: { kind: 'loop', userId: 'admin-uuid-1', email: 'аdmin@loop.test' }, // Cyrillic а
        body: { otp: '123456' },
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('UNAUTHORIZED');
    expect(body.message).toBe('Invalid or expired verification code');
    // Never reaches the OTP store for an un-normalisable email.
    expect(findLiveOtpMock).not.toHaveBeenCalled();
  });

  it('mints a step-up token on a correct OTP, consumes it exactly once, and defaults to the wildcard scope', async () => {
    findLiveOtpMock.mockResolvedValue({ id: 'otp-row-1', attempts: 1 });
    const res = await adminStepUpHandler(makeCtx({ auth: LOOP_ADMIN, body: { otp: '123456' } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stepUpToken: string; expiresAt: string };
    expect(body.stepUpToken).toBe('signed.step.up');
    expect(typeof body.expiresAt).toBe('string');

    expect(markOtpConsumedMock).toHaveBeenCalledTimes(1);
    expect(markOtpConsumedMock).toHaveBeenCalledWith('otp-row-1');

    expect(signMock).toHaveBeenCalledTimes(1);
    const signArgs = signMock.mock.calls[0]?.[0] as { sub: string; email: string; scope?: string };
    expect(signArgs.sub).toBe('admin-uuid-1');
    expect(signArgs.email).toBe('admin@loop.test');
    // CF-08: omitted scope on the wire → handler must not force a scope,
    // letting signAdminStepUpToken apply its own wildcard default.
    expect(signArgs.scope).toBeUndefined();
  });

  it('binds the minted token to an explicit narrower scope when the caller asks for one', async () => {
    findLiveOtpMock.mockResolvedValue({ id: 'otp-row-2', attempts: 0 });
    await adminStepUpHandler(
      makeCtx({ auth: LOOP_ADMIN, body: { otp: '123456', scope: 'withdrawal' } }),
    );
    const signArgs = signMock.mock.calls[0]?.[0] as { scope?: string };
    expect(signArgs.scope).toBe('withdrawal');
  });

  it('500 INTERNAL_ERROR when the OTP lookup throws unexpectedly', async () => {
    findLiveOtpMock.mockRejectedValue(new Error('db unavailable'));
    const res = await adminStepUpHandler(makeCtx({ auth: LOOP_ADMIN, body: { otp: '123456' } }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INTERNAL_ERROR');
  });
});
