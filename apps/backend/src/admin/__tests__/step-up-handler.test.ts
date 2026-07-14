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

const {
  findLiveOtpMock,
  incrementOtpAttemptsMock,
  tryConsumeOtpMock,
  signMock,
  configuredMock,
  isEmailOtpLockedMock,
  registerFailedOtpAttemptMock,
  clearOtpAttemptsMock,
} = vi.hoisted(() => ({
  findLiveOtpMock: vi.fn(),
  incrementOtpAttemptsMock: vi.fn(async () => undefined),
  // BK-otpatomic-stepup: the handler now consumes the OTP with the atomic
  // compare-and-set `tryConsumeOtp` (returns true iff THIS call won the
  // NULL→now() flip) instead of the racy read-then-`markOtpConsumed`.
  tryConsumeOtpMock: vi.fn(async () => true),
  signMock: vi.fn(),
  configuredMock: vi.fn(() => true),
  isEmailOtpLockedMock: vi.fn(async () => false),
  registerFailedOtpAttemptMock: vi.fn(async () => ({ failedAttempts: 1, locked: false })),
  clearOtpAttemptsMock: vi.fn(async () => undefined),
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock('../../auth/otps.js', () => ({
  findLiveOtp: findLiveOtpMock,
  incrementOtpAttempts: incrementOtpAttemptsMock,
  tryConsumeOtp: tryConsumeOtpMock,
}));

vi.mock('../../auth/otp-attempt-counter.js', () => ({
  clearOtpAttempts: clearOtpAttemptsMock,
  isEmailOtpLocked: isEmailOtpLockedMock,
  OTP_EMAIL_LOCKOUT_MS: 15 * 60 * 1000,
  registerFailedOtpAttempt: registerFailedOtpAttemptMock,
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
    'operator-float',
  ] as const,
}));

import { adminStepUpHandler } from '../step-up-handler.js';

function makeCtx(opts: {
  auth?: { kind: 'loop' | 'ctx'; userId: string; email: string } | undefined;
  body?: unknown;
}): Context {
  const store = new Map<string, unknown>();
  const headers: Record<string, string> = {};
  if (opts.auth !== undefined) store.set('auth', opts.auth);
  return {
    req: {
      json: async () => {
        if (opts.body === '__throw__') throw new Error('bad json');
        return opts.body;
      },
    },
    get: (k: string) => store.get(k),
    header: (k: string, v: string) => {
      headers[k] = v;
    },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json', ...headers },
      }),
  } as unknown as Context;
}

const LOOP_ADMIN = { kind: 'loop' as const, userId: 'admin-uuid-1', email: 'admin@loop.test' };

beforeEach(() => {
  findLiveOtpMock.mockReset();
  incrementOtpAttemptsMock.mockReset().mockResolvedValue(undefined);
  tryConsumeOtpMock.mockReset().mockResolvedValue(true);
  signMock.mockReset().mockReturnValue({
    token: 'signed.step.up',
    claims: { exp: Math.floor(Date.now() / 1000) + 300, scope: 'credit-adjustment' },
  });
  configuredMock.mockReset().mockReturnValue(true);
  isEmailOtpLockedMock.mockReset().mockResolvedValue(false);
  registerFailedOtpAttemptMock.mockReset().mockResolvedValue({ failedAttempts: 1, locked: false });
  clearOtpAttemptsMock.mockReset().mockResolvedValue(undefined);
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
    const res = await adminStepUpHandler(
      makeCtx({ auth: LOOP_ADMIN, body: { otp: '000000', scope: 'refund' } }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHORIZED');
    expect(isEmailOtpLockedMock).toHaveBeenCalledWith({ email: 'admin@loop.test' });
    expect(incrementOtpAttemptsMock).toHaveBeenCalledWith({ email: 'admin@loop.test' });
    expect(registerFailedOtpAttemptMock).toHaveBeenCalledWith({ email: 'admin@loop.test' });
    // A wrong guess must never mint a token or consume anything.
    expect(signMock).not.toHaveBeenCalled();
    expect(tryConsumeOtpMock).not.toHaveBeenCalled();
  });

  it('429 TOO_MANY_ATTEMPTS when the admin email is already locked, before checking any OTP', async () => {
    isEmailOtpLockedMock.mockResolvedValue(true);
    const res = await adminStepUpHandler(
      makeCtx({ auth: LOOP_ADMIN, body: { otp: '000000', scope: 'refund' } }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('900');
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('TOO_MANY_ATTEMPTS');
    expect(findLiveOtpMock).not.toHaveBeenCalled();
    expect(incrementOtpAttemptsMock).not.toHaveBeenCalled();
    expect(registerFailedOtpAttemptMock).not.toHaveBeenCalled();
    expect(signMock).not.toHaveBeenCalled();
  });

  it('429 TOO_MANY_ATTEMPTS when a wrong OTP crosses the per-email threshold', async () => {
    findLiveOtpMock.mockResolvedValue(null);
    registerFailedOtpAttemptMock.mockResolvedValue({ failedAttempts: 10, locked: true });
    const res = await adminStepUpHandler(
      makeCtx({ auth: LOOP_ADMIN, body: { otp: '000000', scope: 'refund' } }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('900');
    expect(incrementOtpAttemptsMock).toHaveBeenCalledWith({ email: 'admin@loop.test' });
    expect(registerFailedOtpAttemptMock).toHaveBeenCalledWith({ email: 'admin@loop.test' });
    expect(tryConsumeOtpMock).not.toHaveBeenCalled();
    expect(signMock).not.toHaveBeenCalled();
  });

  it('401 UNAUTHORIZED (same shape as a wrong OTP) for a non-ASCII stored email, without leaking the reason', async () => {
    const res = await adminStepUpHandler(
      makeCtx({
        auth: { kind: 'loop', userId: 'admin-uuid-1', email: 'аdmin@loop.test' }, // Cyrillic а
        body: { otp: '123456', scope: 'refund' },
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('UNAUTHORIZED');
    expect(body.message).toBe('Invalid or expired verification code');
    // Never reaches the OTP store for an un-normalisable email.
    expect(findLiveOtpMock).not.toHaveBeenCalled();
  });

  it('400 VALIDATION_ERROR when scope is omitted (SEC-02-stepup: scope is required, no wildcard default)', async () => {
    // Pre-SEC-02 an omitted scope minted an all-class wildcard token.
    // That default WAS the audited privilege — the mint now requires a
    // concrete class, so a scope-less request never reaches the OTP store
    // or the signer.
    findLiveOtpMock.mockResolvedValue({ id: 'otp-row-x', attempts: 1 });
    const res = await adminStepUpHandler(makeCtx({ auth: LOOP_ADMIN, body: { otp: '123456' } }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(signMock).not.toHaveBeenCalled();
    expect(tryConsumeOtpMock).not.toHaveBeenCalled();
  });

  it('mints a step-up token on a correct OTP + scope, consumes the OTP atomically exactly once', async () => {
    findLiveOtpMock.mockResolvedValue({ id: 'otp-row-1', attempts: 1 });
    const res = await adminStepUpHandler(
      makeCtx({ auth: LOOP_ADMIN, body: { otp: '123456', scope: 'credit-adjustment' } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stepUpToken: string; expiresAt: string };
    expect(body.stepUpToken).toBe('signed.step.up');
    expect(typeof body.expiresAt).toBe('string');

    // BK-otpatomic-stepup: OTP consumed via the atomic CAS exactly once.
    expect(tryConsumeOtpMock).toHaveBeenCalledTimes(1);
    expect(tryConsumeOtpMock).toHaveBeenCalledWith('otp-row-1');
    expect(clearOtpAttemptsMock).toHaveBeenCalledWith('admin@loop.test');

    expect(signMock).toHaveBeenCalledTimes(1);
    const signArgs = signMock.mock.calls[0]?.[0] as { sub: string; email: string; scope?: string };
    expect(signArgs.sub).toBe('admin-uuid-1');
    expect(signArgs.email).toBe('admin@loop.test');
    // SEC-02-stepup: the handler threads the REQUIRED concrete class.
    expect(signArgs.scope).toBe('credit-adjustment');
  });

  it('binds the minted token to the explicit scope the caller asks for', async () => {
    findLiveOtpMock.mockResolvedValue({ id: 'otp-row-2', attempts: 0 });
    await adminStepUpHandler(
      makeCtx({ auth: LOOP_ADMIN, body: { otp: '123456', scope: 'withdrawal' } }),
    );
    const signArgs = signMock.mock.calls[0]?.[0] as { scope?: string };
    expect(signArgs.scope).toBe('withdrawal');
  });

  it('BK-otpatomic-stepup: the LOSER of a concurrent OTP-consume race gets 401 and mints nothing', async () => {
    // Two step-up requests present the same live OTP. `findLiveOtp` sees
    // it unconsumed for both, but the atomic `tryConsumeOtp` lets only one
    // win (true); the loser (false) must be rejected as if the code were
    // already spent — never a second token off one OTP.
    findLiveOtpMock.mockResolvedValue({ id: 'otp-row-race', attempts: 0 });
    tryConsumeOtpMock.mockResolvedValue(false);
    const res = await adminStepUpHandler(
      makeCtx({ auth: LOOP_ADMIN, body: { otp: '123456', scope: 'refund' } }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHORIZED');
    // The loser mints NOTHING and does not clear the attempt counter.
    expect(signMock).not.toHaveBeenCalled();
    expect(clearOtpAttemptsMock).not.toHaveBeenCalled();
  });

  it('500 INTERNAL_ERROR when the OTP lookup throws unexpectedly', async () => {
    findLiveOtpMock.mockRejectedValue(new Error('db unavailable'));
    const res = await adminStepUpHandler(
      makeCtx({ auth: LOOP_ADMIN, body: { otp: '123456', scope: 'refund' } }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INTERNAL_ERROR');
  });
});
