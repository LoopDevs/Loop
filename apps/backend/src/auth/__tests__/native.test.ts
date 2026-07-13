import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import type * as OtpsModule from '../otps.js';

// Loop JWTs are minted by the verify-otp + refresh handlers; set the
// signing key so tokens.ts is configured when the test loads.
vi.hoisted(() => {
  process.env['LOOP_JWT_SIGNING_KEY'] = 'jwt-test-signing-key-32-chars-min!!';
});

const createOtpMock = vi.fn();
const countRecentMock = vi.fn();
const findLiveOtpMock = vi.fn();
const incrementAttemptsMock = vi.fn();
const markConsumedMock = vi.fn();
const sendOtpMock = vi.fn();
const findOrCreateUserMock = vi.fn();
const recordRefreshMock = vi.fn();
const findLiveRefreshMock = vi.fn();
const revokeRefreshMock = vi.fn();
const tryRevokeIfLiveMock = vi.fn();
const findRefreshRecordMock = vi.fn();
const revokeAllRefreshForUserMock = vi.fn();
// B5: per-email OTP attempt counter.
const isEmailOtpLockedMock = vi.fn();
const registerFailedOtpAttemptMock = vi.fn();
const clearOtpAttemptsMock = vi.fn();

vi.mock('../otp-attempt-counter.js', () => ({
  isEmailOtpLocked: (args: unknown) => isEmailOtpLockedMock(args),
  registerFailedOtpAttempt: (args: unknown) => registerFailedOtpAttemptMock(args),
  clearOtpAttempts: (email: string) => clearOtpAttemptsMock(email),
  OTP_EMAIL_LOCKOUT_MS: 900_000,
}));

vi.mock('../otps.js', async () => {
  const actual = await vi.importActual<typeof OtpsModule>('../otps.js');
  return {
    ...actual,
    createOtp: (args: unknown) => createOtpMock(args),
    countRecentOtpsForEmail: (args: unknown) => countRecentMock(args),
    findLiveOtp: (args: unknown) => findLiveOtpMock(args),
    incrementOtpAttempts: (args: unknown) => incrementAttemptsMock(args),
    markOtpConsumed: (id: string) => markConsumedMock(id),
  };
});
vi.mock('../email.js', () => ({
  getEmailProvider: () => ({
    name: 'stub',
    sendOtpEmail: (input: unknown) => sendOtpMock(input),
  }),
}));
vi.mock('../../db/users.js', () => ({
  findOrCreateUserByEmail: (email: string) => findOrCreateUserMock(email),
}));
vi.mock('../refresh-tokens.js', () => ({
  recordRefreshToken: (args: unknown) => recordRefreshMock(args),
  findLiveRefreshToken: (args: unknown) => findLiveRefreshMock(args),
  findRefreshTokenRecord: (jti: string) => findRefreshRecordMock(jti),
  revokeRefreshToken: (args: unknown) => revokeRefreshMock(args),
  // A4-098: native refresh now uses tryRevokeIfLive for the
  // concurrency-safe rotation. Default mocks to "won the race"
  // (true) so existing happy-path tests pass through; the
  // explicit race test flips it to false.
  tryRevokeIfLive: (args: unknown) => tryRevokeIfLiveMock(args),
  revokeAllRefreshTokensForUser: (userId: string) => revokeAllRefreshForUserMock(userId),
}));
vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

import {
  nativeRequestOtpHandler,
  nativeVerifyOtpHandler,
  nativeRefreshHandler,
} from '../native.js';
import { signLoopToken } from '../tokens.js';
// Real (unmocked) runtime-health module — the kill-switch tests below
// assert on the same module instance the handler mutates.
import {
  __resetRuntimeHealthForTests,
  getRuntimeHealthSnapshot,
  setOtpDeliveryEnabled,
} from '../../runtime-health.js';

interface FakeCtx {
  body: unknown;
  ctx: Context;
}

function makeCtx(body: unknown): FakeCtx {
  // Accumulate `c.header(k, v)` calls so response assertions can read
  // them (B5 sets Retry-After on the 429 lockout paths).
  const extraHeaders: Record<string, string> = {};
  return {
    body,
    ctx: {
      req: {
        json: async () => {
          if (body === '__throw__') throw new Error('bad json');
          return body;
        },
      },
      header: (k: string, v: string) => {
        extraHeaders[k] = v;
      },
      json: (b: unknown, status?: number) =>
        new Response(JSON.stringify(b), {
          status: status ?? 200,
          headers: { 'content-type': 'application/json', ...extraHeaders },
        }),
    } as unknown as Context,
  };
}

beforeEach(() => {
  createOtpMock.mockReset();
  countRecentMock.mockReset();
  findLiveOtpMock.mockReset();
  incrementAttemptsMock.mockReset();
  markConsumedMock.mockReset();
  sendOtpMock.mockReset();
  findOrCreateUserMock.mockReset();
  recordRefreshMock.mockReset();
  findLiveRefreshMock.mockReset();
  revokeRefreshMock.mockReset();
  tryRevokeIfLiveMock.mockReset();
  findRefreshRecordMock.mockReset();
  revokeAllRefreshForUserMock.mockReset();
  findRefreshRecordMock.mockResolvedValue(null);
  revokeAllRefreshForUserMock.mockResolvedValue(undefined);
  // B5 defaults: email not locked, wrong-guess doesn't tip over, clear ok.
  isEmailOtpLockedMock.mockReset();
  isEmailOtpLockedMock.mockResolvedValue(false);
  registerFailedOtpAttemptMock.mockReset();
  registerFailedOtpAttemptMock.mockResolvedValue({ failedAttempts: 1, locked: false });
  clearOtpAttemptsMock.mockReset();
  clearOtpAttemptsMock.mockResolvedValue(undefined);

  countRecentMock.mockResolvedValue(0);
  createOtpMock.mockResolvedValue({ id: 'row-1', expiresAt: new Date(Date.now() + 60_000) });
  sendOtpMock.mockResolvedValue(undefined);
  incrementAttemptsMock.mockResolvedValue(undefined);
  markConsumedMock.mockResolvedValue(undefined);
  recordRefreshMock.mockResolvedValue(undefined);
  revokeRefreshMock.mockResolvedValue(undefined);
  tryRevokeIfLiveMock.mockResolvedValue(true);
});

describe('nativeRequestOtpHandler', () => {
  it('400 when the body is not a valid email', async () => {
    const { ctx } = makeCtx({ email: 'not-an-email' });
    const res = await nativeRequestOtpHandler(ctx);
    expect(res.status).toBe(400);
  });

  it('400 when the body is not valid JSON', async () => {
    const { ctx } = makeCtx('__throw__');
    const res = await nativeRequestOtpHandler(ctx);
    expect(res.status).toBe(400);
  });

  it('on a valid email: writes an OTP row and sends via the provider', async () => {
    const { ctx } = makeCtx({ email: 'A@B.COM', platform: 'ios' });
    const res = await nativeRequestOtpHandler(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/Verification code sent/);
    // Email is lower-cased + trimmed before persisting.
    expect(createOtpMock).toHaveBeenCalledWith(expect.objectContaining({ email: 'a@b.com' }));
    expect(sendOtpMock).toHaveBeenCalledWith(expect.objectContaining({ to: 'a@b.com' }));
    // Code passed to createOtp must match the one sent in the email.
    const createdCode = createOtpMock.mock.calls[0]![0].code as string;
    const sentCode = sendOtpMock.mock.calls[0]![0].code as string;
    expect(createdCode).toBe(sentCode);
  });

  it('skips send silently when the per-email cap is hit', async () => {
    countRecentMock.mockResolvedValue(10);
    const { ctx } = makeCtx({ email: 'a@b.com' });
    const res = await nativeRequestOtpHandler(ctx);
    expect(res.status).toBe(200);
    // Same-shape enumeration-safe response, but no row / email.
    expect(createOtpMock).not.toHaveBeenCalled();
    expect(sendOtpMock).not.toHaveBeenCalled();
  });

  it('returns 200 even when the email provider throws (enumeration defence)', async () => {
    sendOtpMock.mockRejectedValue(new Error('provider down'));
    const { ctx } = makeCtx({ email: 'a@b.com' });
    const res = await nativeRequestOtpHandler(ctx);
    expect(res.status).toBe(200);
    // The OTP row was still written; send just failed.
    expect(createOtpMock).toHaveBeenCalled();
  });

  it('returns generic 200 envelope when the OTP row write fails (A4-002 enumeration defense)', async () => {
    // A4-002: the native path used to return 500 on a DB failure,
    // contradicting the CTX-proxy path which collapses every
    // internal failure into the same `{ message: 'Verification
    // code sent' }` 200 envelope so an attacker probing both
    // paths can't distinguish "user not found / DB happy" from
    // "DB outage / queue saturation". Native now matches.
    createOtpMock.mockRejectedValue(new Error('db down'));
    const { ctx } = makeCtx({ email: 'a@b.com' });
    const res = await nativeRequestOtpHandler(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ message: 'Verification code sent' });
  });

  describe('OTP delivery kill-switch (no self-reset)', () => {
    beforeEach(() => {
      __resetRuntimeHealthForTests();
    });

    it('a request that fails validation leaves a disabled kill-switch disabled', async () => {
      // Pre-fix: the handler called setOtpDeliveryEnabled(true)
      // unconditionally on entry, so even a 400 re-armed the surface.
      setOtpDeliveryEnabled(false);
      const { ctx } = makeCtx({ email: 'not-an-email' });
      await nativeRequestOtpHandler(ctx);
      expect(getRuntimeHealthSnapshot().otpDelivery.enabled).toBe(false);
    });

    it('a request whose email send fails leaves a disabled kill-switch disabled (silenced, but error still recorded)', async () => {
      setOtpDeliveryEnabled(false);
      sendOtpMock.mockRejectedValue(new Error('provider down'));
      const { ctx } = makeCtx({ email: 'a@b.com' });
      const res = await nativeRequestOtpHandler(ctx);
      expect(res.status).toBe(200);
      const snap = getRuntimeHealthSnapshot();
      expect(snap.otpDelivery.enabled).toBe(false);
      // Operator silenced the surface — failures must not page…
      expect(snap.otpDelivery.degraded).toBe(false);
      // …but the failure metadata stays truthful for when it re-arms.
      expect(snap.otpDelivery.lastError).toBe('provider down');
    });

    it('only a successful send re-enables the surface (self-heal)', async () => {
      setOtpDeliveryEnabled(false);
      const { ctx } = makeCtx({ email: 'a@b.com' });
      const res = await nativeRequestOtpHandler(ctx);
      expect(res.status).toBe(200);
      const snap = getRuntimeHealthSnapshot();
      expect(snap.otpDelivery.enabled).toBe(true);
      expect(snap.otpDelivery.degraded).toBe(false);
    });
  });
});

describe('nativeVerifyOtpHandler', () => {
  it('400 on invalid body', async () => {
    const { ctx } = makeCtx({ email: 'not-email', otp: '123456' });
    expect((await nativeVerifyOtpHandler(ctx)).status).toBe(400);
  });

  it('401 when no live OTP row matches and bumps the attempts counter', async () => {
    findLiveOtpMock.mockResolvedValue(null);
    const { ctx } = makeCtx({ email: 'a@b.com', otp: '000000' });
    const res = await nativeVerifyOtpHandler(ctx);
    expect(res.status).toBe(401);
    expect(incrementAttemptsMock).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'a@b.com' }),
    );
  });

  it('B5: 429 when the email is already locked — never touches the code', async () => {
    isEmailOtpLockedMock.mockResolvedValue(true);
    const { ctx } = makeCtx({ email: 'a@b.com', otp: '123456' });
    const res = await nativeVerifyOtpHandler(ctx);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code: string }).code).toBe('TOO_MANY_ATTEMPTS');
    expect(res.headers.get('Retry-After')).toBe('900');
    // Locked out BEFORE the hash comparison — no live-OTP lookup.
    expect(findLiveOtpMock).not.toHaveBeenCalled();
  });

  it('B5: registers a failed attempt on a wrong code (401 when under threshold)', async () => {
    findLiveOtpMock.mockResolvedValue(null);
    // SEC-15: a wrong guess only arms the per-email lockout when a live OTP
    // exists to be brute-forced. Establish one (a real pending code the
    // user is fat-fingering).
    countRecentMock.mockResolvedValue(1);
    registerFailedOtpAttemptMock.mockResolvedValue({ failedAttempts: 3, locked: false });
    const { ctx } = makeCtx({ email: 'a@b.com', otp: '000000' });
    const res = await nativeVerifyOtpHandler(ctx);
    expect(res.status).toBe(401);
    expect(registerFailedOtpAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'a@b.com' }),
    );
  });

  it('B5: 429 when the wrong guess tips the email over the threshold', async () => {
    findLiveOtpMock.mockResolvedValue(null);
    // SEC-15: a live OTP is present (real login/attack traffic), so the
    // brute-force ceiling still applies unchanged.
    countRecentMock.mockResolvedValue(1);
    registerFailedOtpAttemptMock.mockResolvedValue({ failedAttempts: 10, locked: true });
    const { ctx } = makeCtx({ email: 'a@b.com', otp: '000000' });
    const res = await nativeVerifyOtpHandler(ctx);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code: string }).code).toBe('TOO_MANY_ATTEMPTS');
    expect(res.headers.get('Retry-After')).toBe('900');
  });

  it('SEC-15: a wrong guess against an email with NO live OTP does NOT arm the per-email lockout', async () => {
    // The unauth DoS: an attacker POSTs wrong codes for a victim (incl. an
    // admin) whose email has no outstanding OTP. Pre-fix, every such guess
    // called registerFailedOtpAttempt and, at the threshold, 429-locked the
    // victim out of login AND admin step-up — free, silent, unauthenticated.
    findLiveOtpMock.mockResolvedValue(null);
    // No recent OTP rows → nothing to brute-force.
    countRecentMock.mockResolvedValue(0);
    // Rigged so that IF the counter were (wrongly) consulted, it would
    // report a lock — making the pre-fix code return 429 and proving the
    // test is non-vacuous (it fails red against the un-gated handler).
    registerFailedOtpAttemptMock.mockResolvedValue({ failedAttempts: 10, locked: true });
    const { ctx } = makeCtx({ email: 'victim-admin@b.com', otp: '000000' });
    const res = await nativeVerifyOtpHandler(ctx);
    // Same generic 401 as any wrong code — but the lockout was NOT armed.
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('UNAUTHORIZED');
    expect(registerFailedOtpAttemptMock).not.toHaveBeenCalled();
    // The per-row bump is unconditional (harmless no-op when no live row),
    // so it still fires — only the per-EMAIL lockout arming is gated.
    expect(incrementAttemptsMock).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'victim-admin@b.com' }),
    );
  });

  it('consumes the OTP, upserts the user, mints a pair, and clears the counter on success', async () => {
    findLiveOtpMock.mockResolvedValue({ id: 'otp-1', attempts: 0 });
    findOrCreateUserMock.mockResolvedValue({ id: 'user-1', email: 'a@b.com' });
    const { ctx } = makeCtx({ email: 'a@b.com', otp: '123456' });
    const res = await nativeVerifyOtpHandler(ctx);
    expect(res.status).toBe(200);
    expect(markConsumedMock).toHaveBeenCalledWith('otp-1');
    expect(findOrCreateUserMock).toHaveBeenCalledWith('a@b.com');
    expect(recordRefreshMock).toHaveBeenCalled();
    // B5: the email's failed-attempt counter is cleared on success.
    expect(clearOtpAttemptsMock).toHaveBeenCalledWith('a@b.com');
    const body = (await res.json()) as { accessToken: string; refreshToken: string };
    expect(body.accessToken.split('.')).toHaveLength(3);
    expect(body.refreshToken.split('.')).toHaveLength(3);
  });

  it('returns 500 on a db failure inside user upsert', async () => {
    findLiveOtpMock.mockResolvedValue({ id: 'otp-1', attempts: 0 });
    findOrCreateUserMock.mockRejectedValue(new Error('db down'));
    const { ctx } = makeCtx({ email: 'a@b.com', otp: '123456' });
    expect((await nativeVerifyOtpHandler(ctx)).status).toBe(500);
  });
});

describe('nativeRefreshHandler', () => {
  it('400 on invalid body', async () => {
    const { ctx } = makeCtx({});
    expect((await nativeRefreshHandler(ctx)).status).toBe(400);
  });

  it('401 on a token that does not verify', async () => {
    const { ctx } = makeCtx({ refreshToken: 'garbage' });
    expect((await nativeRefreshHandler(ctx)).status).toBe(401);
  });

  it('401 when the jti has no live row', async () => {
    const { token } = signLoopToken({
      sub: 'user-1',
      email: 'a@b.com',
      typ: 'refresh',
      ttlSeconds: 300,
    });
    findLiveRefreshMock.mockResolvedValue(null);
    // Record-not-found case: no reuse, just forged / cleaned-up
    findRefreshRecordMock.mockResolvedValue(null);
    const { ctx } = makeCtx({ refreshToken: token });
    expect((await nativeRefreshHandler(ctx)).status).toBe(401);
    expect(revokeAllRefreshForUserMock).not.toHaveBeenCalled();
  });

  it('A2-1608: refresh-token reuse (revoked row exists) → revokes the entire family', async () => {
    const { token, claims } = signLoopToken({
      sub: 'user-1',
      email: 'a@b.com',
      typ: 'refresh',
      ttlSeconds: 300,
    });
    // findLiveRefreshToken returns null (row revoked, so live filter
    // excludes it). findRefreshTokenRecord returns the revoked row.
    findLiveRefreshMock.mockResolvedValue(null);
    findRefreshRecordMock.mockResolvedValue({
      jti: claims.jti,
      userId: 'user-1',
      revokedAt: new Date(),
    });
    const { ctx } = makeCtx({ refreshToken: token });
    const res = await nativeRefreshHandler(ctx);
    expect(res.status).toBe(401);
    expect(revokeAllRefreshForUserMock).toHaveBeenCalledWith('user-1');
  });

  it('rotates: revokes the old jti, issues a new pair', async () => {
    const { token: oldRefresh, claims: oldClaims } = signLoopToken({
      sub: 'user-1',
      email: 'a@b.com',
      typ: 'refresh',
      ttlSeconds: 300,
    });
    findLiveRefreshMock.mockResolvedValue({ jti: oldClaims.jti, userId: 'user-1' });
    const { ctx } = makeCtx({ refreshToken: oldRefresh });
    const res = await nativeRefreshHandler(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accessToken: string; refreshToken: string };
    expect(body.refreshToken).not.toBe(oldRefresh);
    expect(recordRefreshMock).toHaveBeenCalled();
    // A4-098: rotation goes through tryRevokeIfLive (compare-and-set)
    // rather than the unconditional revokeRefreshToken. Pin that.
    expect(tryRevokeIfLiveMock).toHaveBeenCalledWith(
      expect.objectContaining({ jti: oldClaims.jti }),
    );
    const newJti = recordRefreshMock.mock.calls[0]![0].jti as string;
    const revokeArgs = tryRevokeIfLiveMock.mock.calls[0]![0] as { replacedByJti: string };
    expect(revokeArgs.replacedByJti).toBe(newJti);
    // A4-098 ordering: the successor row is persisted only AFTER the
    // compare-and-set revoke succeeds. Persist-before-CAS is the
    // orphaned-live-row bug.
    expect(tryRevokeIfLiveMock.mock.invocationCallOrder[0]!).toBeLessThan(
      recordRefreshMock.mock.invocationCallOrder[0]!,
    );
  });

  it('A4-098: concurrent rotation that loses the CAS rejects with 401 instead of minting a parallel pair', async () => {
    const { token: oldRefresh, claims: oldClaims } = signLoopToken({
      sub: 'user-1',
      email: 'a@b.com',
      typ: 'refresh',
      ttlSeconds: 300,
    });
    findLiveRefreshMock.mockResolvedValue({ jti: oldClaims.jti, userId: 'user-1' });
    // Simulate the race: another concurrent refresh request already
    // revoked the prior token. Our compare-and-set returns false.
    tryRevokeIfLiveMock.mockResolvedValue(false);
    const { ctx } = makeCtx({ refreshToken: oldRefresh });
    const res = await nativeRefreshHandler(ctx);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHORIZED');
    // The loser must NOT have persisted a successor refresh row —
    // doing so before (or despite) losing the CAS is exactly the
    // orphaned-live-row bug: a live credential nothing ever revokes.
    expect(recordRefreshMock).not.toHaveBeenCalled();
    // And losing a rotation race is not a theft signal.
    expect(revokeAllRefreshForUserMock).not.toHaveBeenCalled();
  });

  it('401 on an access token used where a refresh is expected', async () => {
    const { token } = signLoopToken({
      sub: 'user-1',
      email: 'a@b.com',
      typ: 'access',
      ttlSeconds: 300,
    });
    const { ctx } = makeCtx({ refreshToken: token });
    expect((await nativeRefreshHandler(ctx)).status).toBe(401);
  });
});
