// BK-otpatomic regression: concurrent verify-otp single-use against real store
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Context } from 'hono';
import type * as OtpsModule from '../../auth/otps.js';
import { db, __resetDbForTests } from '../../db/client.js';

// Rendezvous barrier: first N-1 readers block, Nth releases all, ensuring all observe pre-consume row
const barrier = vi.hoisted(() => {
  let expected = 0;
  let parked: Array<() => void> = [];
  return {
    arm(n: number): void {
      expected = n;
      parked = [];
    },
    async wait(): Promise<void> {
      if (expected <= 1) return;
      await new Promise<void>((resolve) => {
        parked.push(resolve);
        if (parked.length === expected) {
          const release = parked;
          parked = [];
          expected = 0;
          for (const r of release) r();
        }
      });
    },
  };
});

// Wraps only findLiveOtp with barrier; tryConsumeOtp and others use real impl
vi.mock('../../auth/otps.js', async () => {
  const actual = await vi.importActual<typeof OtpsModule>('../../auth/otps.js');
  return {
    ...actual,
    findLiveOtp: async (args: Parameters<typeof actual.findLiveOtp>[0]) => {
      const hit = await actual.findLiveOtp(args);
      await barrier.wait();
      return hit;
    },
  };
});

import { nativeVerifyOtpHandler } from '../../auth/native.js';
import { createOtp } from '../../auth/otps.js';

function makeCtx(body: unknown): Context {
  const headers: Record<string, string> = {};
  return {
    req: { json: async () => body },
    header: (k: string, v: string) => {
      headers[k] = v;
    },
    json: (b: unknown, status?: number) =>
      new Response(JSON.stringify(b), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json', ...headers },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  __resetDbForTests();
});

describe('BK-otpatomic: concurrent verify-otp single-use (real DB)', () => {
  it('two concurrent verifies with the same valid code → exactly one 200, one 401', async () => {
    const email = 'race@example.com';
    const code = '135790';
    await createOtp({ email, code });

    barrier.arm(2);
    const [resA, resB] = await Promise.all([
      nativeVerifyOtpHandler(makeCtx({ email, otp: code })),
      nativeVerifyOtpHandler(makeCtx({ email, otp: code })),
    ]);

    expect([resA.status, resB.status].sort((a, b) => a - b)).toEqual([200, 401]);

    const winnerRes = resA.status === 200 ? resA : resB;
    const loserRes = resA.status === 200 ? resB : resA;
    const winnerBody = (await winnerRes.json()) as { accessToken: string; refreshToken: string };
    const loserBody = (await loserRes.json()) as { code: string };
    expect(winnerBody.accessToken.split('.')).toHaveLength(3);
    expect(winnerBody.refreshToken.split('.')).toHaveLength(3);
    expect(loserBody.code).toBe('UNAUTHORIZED');

    const otpRows = await db.collection('otps').findMany({ email });
    expect(otpRows).toHaveLength(1);
    expect(otpRows[0]?.consumedAt).not.toBeNull();

    const userRows = await db.collection('users').findMany({ email });
    expect(userRows).toHaveLength(1);
    const userId = userRows[0]!.id;
    const refreshRows = await db.collection('refresh_tokens').findMany({ userId });
    expect(refreshRows).toHaveLength(1);
  });
});
