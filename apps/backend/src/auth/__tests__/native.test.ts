import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import type * as OtpsModule from '../otps.js';

// Loop JWTs are minted by the verify-otp + refresh handlers; set the
// signing key so tokens.ts is configured when the test loads.
vi.hoisted(() => {
  process.env['LOOP_JWT_SIGNING_KEY'] = 'k'.repeat(32);
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
  revokeRefreshToken: (args: unknown) => revokeRefreshMock(args),
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

interface FakeCtx {
  body: unknown;
  ctx: Context;
}

function makeCtx(body: unknown): FakeCtx {
  return {
    body,
    ctx: {
      req: {
        json: async () => {
          if (body === '__throw__') throw new Error('bad json');
          return body;
        },
      },
      json: (b: unknown, status?: number) =>
        new Response(JSON.stringify(b), {
          status: status ?? 200,
          headers: { 'content-type': 'application/json' },
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

  countRecentMock.mockResolvedValue(0);
  createOtpMock.mockResolvedValue({ id: 'row-1', expiresAt: new Date(Date.now() + 60_000) });
  sendOtpMock.mockResolvedValue(undefined);
  incrementAttemptsMock.mockResolvedValue(undefined);
  markConsumedMock.mockResolvedValue(undefined);
  recordRefreshMock.mockResolvedValue(undefined);
  revokeRefreshMock.mockResolvedValue(undefined);
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

  it('returns 500 when the OTP row write fails', async () => {
    createOtpMock.mockRejectedValue(new Error('db down'));
    const { ctx } = makeCtx({ email: 'a@b.com' });
    const res = await nativeRequestOtpHandler(ctx);
    expect(res.status).toBe(500);
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

  it('consumes the OTP, upserts the user, and mints a token pair on success', async () => {
    findLiveOtpMock.mockResolvedValue({ id: 'otp-1', attempts: 0 });
    findOrCreateUserMock.mockResolvedValue({ id: 'user-1', email: 'a@b.com' });
    const { ctx } = makeCtx({ email: 'a@b.com', otp: '123456' });
    const res = await nativeVerifyOtpHandler(ctx);
    expect(res.status).toBe(200);
    expect(markConsumedMock).toHaveBeenCalledWith('otp-1');
    expect(findOrCreateUserMock).toHaveBeenCalledWith('a@b.com');
    expect(recordRefreshMock).toHaveBeenCalled();
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
    const { ctx } = makeCtx({ refreshToken: token });
    expect((await nativeRefreshHandler(ctx)).status).toBe(401);
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
    expect(revokeRefreshMock).toHaveBeenCalledWith(expect.objectContaining({ jti: oldClaims.jti }));
    // The revoke call's replacedByJti should link to the new refresh's jti.
    const newJti = recordRefreshMock.mock.calls[0]![0].jti as string;
    const revokeArgs = revokeRefreshMock.mock.calls[0]![0] as { replacedByJti: string };
    expect(revokeArgs.replacedByJti).toBe(newJti);
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
