import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import type * as OtpsModule from '../otps.js';

const createOtpMock = vi.fn();
const countRecentMock = vi.fn();
const sendOtpMock = vi.fn();

vi.mock('../otps.js', async () => {
  const actual = await vi.importActual<typeof OtpsModule>('../otps.js');
  return {
    ...actual,
    createOtp: (args: unknown) => createOtpMock(args),
    countRecentOtpsForEmail: (args: unknown) => countRecentMock(args),
  };
});
vi.mock('../email.js', () => ({
  getEmailProvider: () => ({
    name: 'stub',
    sendOtpEmail: (input: unknown) => sendOtpMock(input),
  }),
}));
vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

import { nativeRequestOtpHandler } from '../native.js';

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
  sendOtpMock.mockReset();
  countRecentMock.mockResolvedValue(0);
  createOtpMock.mockResolvedValue({ id: 'row-1', expiresAt: new Date(Date.now() + 60_000) });
  sendOtpMock.mockResolvedValue(undefined);
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
