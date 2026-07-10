/**
 * Unit coverage for `GET /api/admin/users/:userId/auth-state`
 * (readiness-backlog A5-3, `../user-auth-state.ts`).
 *
 * `db.select()` is mocked as a call-order-indexed thenable chain (same
 * "always-resolves-on-await regardless of which builder method was
 * last called" trick as `staff-route-gating.test.ts`'s `makeChain()`):
 * the handler's four queries are fired inside a single `Promise.all`
 * in a fixed source order (otpAttemptCounters lock row → otps
 * last-request → otps last-verify → refreshTokens active-session
 * count), so canning `state.selectResults[callIndex]` per call
 * reproduces each source's rows without needing to introspect the
 * captured `.where()` predicate.
 *
 * Covers: uuid validation; 404 on unknown user; never leaks a code
 * hash / token hash (only the declared response fields are asserted,
 * proving nothing else rides along); the empty-state default; a
 * currently-locked snapshot; a lapsed-lock row correctly reporting
 * `locked: false`; last-request/last-verify timestamps; the active
 * session count; and 500 on both the user lookup and a downstream
 * query failing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  getUserByIdResult: null as null | { id: string; email: string },
  getUserByIdThrow: null as Error | null,
  selectResults: [] as unknown[][],
  selectThrow: null as Error | null,
  callIndex: 0,
}));

vi.mock('../../db/users.js', () => ({
  getUserById: vi.fn(async () => {
    if (state.getUserByIdThrow !== null) throw state.getUserByIdThrow;
    return state.getUserByIdResult;
  }),
}));

vi.mock('../../db/schema.js', () => ({
  otpAttemptCounters: { email: 'oac.email', lockedUntil: 'oac.locked_until' },
  otps: { email: 'otps.email', createdAt: 'otps.created_at', consumedAt: 'otps.consumed_at' },
  refreshTokens: {
    userId: 'rt.user_id',
    revokedAt: 'rt.revoked_at',
    expiresAt: 'rt.expires_at',
  },
}));

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => {
      const idx = state.callIndex;
      state.callIndex += 1;
      const chain: Record<string, unknown> = {};
      for (const m of ['from', 'where', 'orderBy', 'limit']) {
        chain[m] = () => chain;
      }
      chain['then'] = (
        resolve: (rows: unknown[]) => void,
        reject: (err: unknown) => void,
      ): Promise<void> => {
        if (state.selectThrow !== null) return Promise.reject(state.selectThrow).catch(reject);
        return Promise.resolve(resolve(state.selectResults[idx] ?? []));
      };
      return chain;
    },
  },
}));

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { adminUserAuthStateHandler } from '../user-auth-state.js';

const targetUserId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const targetEmail = 'target@loop.test';

function makeCtx(userId?: string): Context {
  return {
    req: { param: (k: string) => (k === 'userId' ? (userId ?? targetUserId) : undefined) },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  state.getUserByIdResult = { id: targetUserId, email: targetEmail };
  state.getUserByIdThrow = null;
  state.selectResults = [];
  state.selectThrow = null;
  state.callIndex = 0;
});

describe('adminUserAuthStateHandler', () => {
  it('400 when userId is not a uuid', async () => {
    const res = await adminUserAuthStateHandler(makeCtx('not-a-uuid'));
    expect(res.status).toBe(400);
  });

  it('404 when the user does not exist', async () => {
    state.getUserByIdResult = null;
    const res = await adminUserAuthStateHandler(makeCtx());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('USER_NOT_FOUND');
  });

  it('500 when the user lookup throws', async () => {
    state.getUserByIdThrow = new Error('db down');
    const res = await adminUserAuthStateHandler(makeCtx());
    expect(res.status).toBe(500);
  });

  it('200 with the empty-state default when nothing is on record', async () => {
    const res = await adminUserAuthStateHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      userId: targetUserId,
      otpLock: { locked: false, lockedUntil: null, failedAttempts: 0 },
      lastOtpRequestedAt: null,
      lastOtpVerifiedAt: null,
      activeSessionCount: 0,
    });
    // Never leaks a code / hash — only the declared fields exist.
    expect(Object.keys(body)).toEqual([
      'userId',
      'otpLock',
      'lastOtpRequestedAt',
      'lastOtpVerifiedAt',
      'activeSessionCount',
    ]);
  });

  it('reports locked: true with the lockedUntil + failedAttempts when currently locked', async () => {
    const lockedUntil = new Date(Date.now() + 5 * 60 * 1000);
    state.selectResults = [[{ lockedUntil, failedAttempts: 10 }], [], [], []];
    const res = await adminUserAuthStateHandler(makeCtx());
    const body = (await res.json()) as {
      otpLock: { locked: boolean; lockedUntil: string | null; failedAttempts: number };
    };
    expect(body.otpLock).toEqual({
      locked: true,
      lockedUntil: lockedUntil.toISOString(),
      failedAttempts: 10,
    });
  });

  it('reports locked: false when the counter row exists but its lock has lapsed', async () => {
    const lockedUntil = new Date(Date.now() - 60_000);
    state.selectResults = [[{ lockedUntil, failedAttempts: 10 }], [], [], []];
    const res = await adminUserAuthStateHandler(makeCtx());
    const body = (await res.json()) as { otpLock: { locked: boolean } };
    expect(body.otpLock.locked).toBe(false);
  });

  it('surfaces last-request / last-verify timestamps and the active session count', async () => {
    const requestedAt = new Date('2026-07-01T10:00:00Z');
    const verifiedAt = new Date('2026-07-01T10:00:30Z');
    state.selectResults = [
      [],
      [{ createdAt: requestedAt }],
      [{ consumedAt: verifiedAt }],
      [{ n: 3 }],
    ];
    const res = await adminUserAuthStateHandler(makeCtx());
    const body = (await res.json()) as {
      lastOtpRequestedAt: string | null;
      lastOtpVerifiedAt: string | null;
      activeSessionCount: number;
    };
    expect(body.lastOtpRequestedAt).toBe(requestedAt.toISOString());
    expect(body.lastOtpVerifiedAt).toBe(verifiedAt.toISOString());
    expect(body.activeSessionCount).toBe(3);
  });

  it('500 when a downstream query fails', async () => {
    state.selectThrow = new Error('boom');
    const res = await adminUserAuthStateHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
