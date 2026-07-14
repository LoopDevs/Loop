/**
 * Unit coverage for `POST /api/admin/users/:userId/clear-otp-lockout`
 * (readiness-backlog A5-3, `../clear-otp-lockout.ts`). Mirrors the
 * mock shape of `home-currency-set.test.ts` (idempotency guard +
 * Discord audit mocked so the handler's own validation/branching runs
 * for real) plus a minimal `db.select` chain for the pre-clear
 * lockedUntil read and a mocked `clearOtpAttempts` primitive.
 *
 * Covers: uuid/idempotency-key/actor/body validation; 404 on unknown
 * target; the SAME `clearOtpAttempts` primitive is called with the
 * TARGET's email (not the actor's); `wasLocked` reflects the
 * pre-clear state (true when locked-and-future, false when no row or
 * a lapsed lock — idempotent no-op either way); the reason lands in
 * the Discord audit; idempotency-key replay skips the DB write
 * entirely and re-fires Discord with `replayed: true`; never-500 on
 * expected errors, 500 on unexpected ones.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  getUserByIdResult: null as null | { id: string; email: string },
  getUserByIdThrow: null as Error | null,
  lockRows: [] as Array<{ lockedUntil: Date | null }>,
  clearCalls: [] as string[],
  clearThrow: null as Error | null,
  priorClearCount: 0,
  countThrow: null as Error | null,
  countCalls: [] as Array<{ path: string; windowMs: number }>,
  // SEC-clearotp: result of the per-target `pg_try_advisory_xact_lock`.
  // false simulates a concurrent clear for the same target already holding
  // the lock (the burst-loser path).
  tryLockLocked: true,
  priorSnapshot: null as null | { status: number; body: Record<string, unknown> },
  storedSnapshot: null as null | Record<string, unknown>,
  discordCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../db/users.js', () => ({
  getUserById: vi.fn(async () => {
    if (state.getUserByIdThrow !== null) throw state.getUserByIdThrow;
    return state.getUserByIdResult;
  }),
}));

vi.mock('../../auth/otp-attempt-counter.js', () => ({
  clearOtpAttempts: vi.fn(async (email: string) => {
    if (state.clearThrow !== null) throw state.clearThrow;
    state.clearCalls.push(email);
  }),
}));

vi.mock('../../db/schema.js', () => ({
  otpAttemptCounters: {
    email: 'otp_attempt_counters.email',
    lockedUntil: 'otp_attempt_counters.locked_until',
  },
}));

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => {
      const chain: Record<string, unknown> = {};
      chain['from'] = () => chain;
      chain['where'] = () => chain;
      chain['limit'] = () => Promise.resolve(state.lockRows);
      return chain;
    },
    // SEC-clearotp: the handler now wraps the guard in an outer txn that
    // acquires a per-target `pg_try_advisory_xact_lock`. Passthrough that
    // hands the callback an `outerTx` whose `execute` returns the rigged
    // lock result.
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ execute: async () => [{ locked: state.tryLockLocked }] }),
  },
}));

vi.mock('../idempotency.js', () => ({
  IDEMPOTENCY_KEY_MIN: 16,
  IDEMPOTENCY_KEY_MAX: 128,
  validateIdempotencyKey: (k: string | undefined): k is string =>
    k !== undefined && k.length >= 16 && k.length <= 128,
  countAppliedActionsForPath: vi.fn(async (args: { path: string; windowMs: number }) => {
    state.countCalls.push(args);
    if (state.countThrow !== null) throw state.countThrow;
    return state.priorClearCount;
  }),
  withIdempotencyGuard: vi.fn(
    async (
      args: { adminUserId: string; key: string; method: string; path: string },
      doWrite: () => Promise<{ status: number; body: Record<string, unknown> }>,
    ) => {
      if (state.priorSnapshot !== null) {
        return {
          replayed: true,
          status: state.priorSnapshot.status,
          body: state.priorSnapshot.body,
        };
      }
      const { status, body } = await doWrite();
      state.storedSnapshot = {
        adminUserId: args.adminUserId,
        key: args.key,
        method: args.method,
        path: args.path,
        status,
        body,
      };
      return { replayed: false, status, body };
    },
  ),
}));

vi.mock('../../discord.js', () => ({
  notifyAdminAudit: vi.fn((args: Record<string, unknown>) => {
    state.discordCalls.push(args);
  }),
}));

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import {
  adminClearOtpLockoutHandler,
  CLEAR_LOCKOUT_MAX_PER_TARGET_PER_DAY,
  CLEAR_LOCKOUT_WINDOW_MS,
} from '../clear-otp-lockout.js';

const adminUser = { id: '11111111-1111-1111-1111-111111111111', email: 'admin@loop.test' };
const targetUserId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const targetEmail = 'target@loop.test';
const validKey = 'k'.repeat(32);

function makeCtx(args: {
  userId?: string;
  headers?: Record<string, string>;
  body?: unknown;
  user?: typeof adminUser | null;
}): Context {
  const resolved = args.user === null ? undefined : (args.user ?? adminUser);
  const store = new Map<string, unknown>();
  if (resolved !== undefined) store.set('user', resolved);
  return {
    req: {
      param: (k: string) => (k === 'userId' ? (args.userId ?? targetUserId) : undefined),
      header: (k: string) => args.headers?.[k.toLowerCase()],
      json: async () => {
        if (args.body === undefined) throw new Error('no body');
        return args.body;
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

beforeEach(() => {
  state.getUserByIdResult = { id: targetUserId, email: targetEmail };
  state.getUserByIdThrow = null;
  state.lockRows = [];
  state.clearCalls = [];
  state.clearThrow = null;
  state.priorClearCount = 0;
  state.countThrow = null;
  state.countCalls = [];
  state.tryLockLocked = true;
  state.priorSnapshot = null;
  state.storedSnapshot = null;
  state.discordCalls = [];
});

describe('adminClearOtpLockoutHandler', () => {
  it('400 when userId is not a uuid', async () => {
    const res = await adminClearOtpLockoutHandler(
      makeCtx({
        userId: 'not-a-uuid',
        headers: { 'idempotency-key': validKey },
        body: { reason: 'user locked out, support ticket #7' },
      }),
    );
    expect(res.status).toBe(400);
    expect(state.clearCalls).toHaveLength(0);
  });

  it('400 when Idempotency-Key header is missing', async () => {
    const res = await adminClearOtpLockoutHandler(makeCtx({ body: { reason: 'ok reason here' } }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('401 when admin context is missing', async () => {
    const res = await adminClearOtpLockoutHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { reason: 'ok reason here' },
        user: null,
      }),
    );
    expect(res.status).toBe(401);
  });

  it('400 when the body is invalid JSON', async () => {
    const ctx = {
      req: {
        param: () => targetUserId,
        header: (k: string) => (k.toLowerCase() === 'idempotency-key' ? validKey : undefined),
        json: async () => {
          throw new Error('bad json');
        },
      },
      get: () => adminUser,
      json: (body: unknown, status?: number) =>
        new Response(JSON.stringify(body), {
          status: status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
    } as unknown as Context;
    const res = await adminClearOtpLockoutHandler(ctx);
    expect(res.status).toBe(400);
  });

  it('400 when reason is too short', async () => {
    const res = await adminClearOtpLockoutHandler(
      makeCtx({ headers: { 'idempotency-key': validKey }, body: { reason: 'x' } }),
    );
    expect(res.status).toBe(400);
    expect(state.clearCalls).toHaveLength(0);
  });

  it('400 when reason exceeds 500 chars', async () => {
    const res = await adminClearOtpLockoutHandler(
      makeCtx({ headers: { 'idempotency-key': validKey }, body: { reason: 'x'.repeat(501) } }),
    );
    expect(res.status).toBe(400);
    expect(state.clearCalls).toHaveLength(0);
  });

  it('400 when reason is missing entirely', async () => {
    const res = await adminClearOtpLockoutHandler(
      makeCtx({ headers: { 'idempotency-key': validKey }, body: {} }),
    );
    expect(res.status).toBe(400);
  });

  it('404 when target user does not exist', async () => {
    state.getUserByIdResult = null;
    const res = await adminClearOtpLockoutHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { reason: 'user locked out, support ticket #7' },
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('USER_NOT_FOUND');
    expect(state.clearCalls).toHaveLength(0);
    expect(state.discordCalls).toHaveLength(0);
  });

  it('500 when the target lookup throws', async () => {
    state.getUserByIdThrow = new Error('db down');
    const res = await adminClearOtpLockoutHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { reason: 'user locked out, support ticket #7' },
      }),
    );
    expect(res.status).toBe(500);
  });

  it('clears the lockout using the TARGET user’s email, wasLocked: true when currently locked', async () => {
    state.lockRows = [{ lockedUntil: new Date(Date.now() + 5 * 60 * 1000) }];
    const res = await adminClearOtpLockoutHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { reason: 'user locked out, support ticket #7' },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { userId: string; wasLocked: boolean; cleared: true };
      audit: { actorUserId: string; replayed: boolean };
    };
    expect(body.result).toEqual({ userId: targetUserId, wasLocked: true, cleared: true });
    expect(body.audit.actorUserId).toBe(adminUser.id);
    expect(body.audit.replayed).toBe(false);
    // Reuses the actual clear primitive, keyed on the TARGET's email —
    // never the acting admin's.
    expect(state.clearCalls).toEqual([targetEmail]);
    expect(state.discordCalls).toHaveLength(1);
    expect(state.discordCalls[0]).toMatchObject({
      actorUserId: adminUser.id,
      targetUserId,
      reason: 'user locked out, support ticket #7',
      idempotencyKey: validKey,
      replayed: false,
    });
  });

  it('idempotent: wasLocked: false and still succeeds when there is no counter row', async () => {
    state.lockRows = [];
    const res = await adminClearOtpLockoutHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { reason: 'pre-emptive clear, support ticket #8' },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { userId: string; wasLocked: boolean; cleared: true };
    };
    expect(body.result).toEqual({ userId: targetUserId, wasLocked: false, cleared: true });
    // Still calls the (no-op) delete — single unlock path, no branching.
    expect(state.clearCalls).toEqual([targetEmail]);
  });

  it('wasLocked: false when a counter row exists but its lock has already lapsed', async () => {
    state.lockRows = [{ lockedUntil: new Date(Date.now() - 60_000) }];
    const res = await adminClearOtpLockoutHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { reason: 'stale row cleanup, support ticket #9' },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { wasLocked: boolean } };
    expect(body.result.wasLocked).toBe(false);
  });

  it('replays the stored snapshot on idempotency-key reuse without re-clearing, Discord re-fires with replayed=true', async () => {
    state.priorSnapshot = {
      status: 200,
      body: {
        result: { userId: targetUserId, wasLocked: true, cleared: true },
        audit: {
          actorUserId: adminUser.id,
          actorEmail: adminUser.email,
          idempotencyKey: validKey,
          appliedAt: '2026-07-08T12:00:00.000Z',
          replayed: false,
        },
      },
    };
    const res = await adminClearOtpLockoutHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { reason: 'user locked out, support ticket #7' },
      }),
    );
    expect(res.status).toBe(200);
    expect(state.clearCalls).toHaveLength(0);
    // Discord still fires on a replay (full audit trail — matches the
    // home-currency-set / refetch-redemption convention), but tagged.
    expect(state.discordCalls).toHaveLength(1);
    expect(state.discordCalls[0]).toMatchObject({ replayed: true });
  });

  it('500 on an unexpected error clearing the counter, no Discord audit fired', async () => {
    state.clearThrow = new Error('boom');
    const res = await adminClearOtpLockoutHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { reason: 'user locked out, support ticket #7' },
      }),
    );
    expect(res.status).toBe(500);
    expect(state.discordCalls).toHaveLength(0);
  });
});

// Review P1: the per-target (userId) velocity cap is the control that
// actually bounds the clear→guess→clear B5-defeat loop (the per-IP
// route limit can't). These assertions FAIL against the pre-cap code
// (which had no count check, so `state.priorClearCount` was ignored and
// every clear returned 200) and pass after.
describe('adminClearOtpLockoutHandler — per-target velocity cap (A5-3 P1)', () => {
  const body = { reason: 'user locked out, support ticket #7' };

  it('allows the first CLEAR_LOCKOUT_MAX_PER_TARGET_PER_DAY clears, rejects the next with 429', async () => {
    // `priorClearCount` = already-applied clears for this target in the
    // window. 0..MAX-1 prior → this request is the 1st..MAXth → allowed;
    // MAX prior → this request is the (MAX+1)th → rejected.
    for (let prior = 0; prior < CLEAR_LOCKOUT_MAX_PER_TARGET_PER_DAY; prior++) {
      state.priorClearCount = prior;
      state.clearCalls = [];
      const res = await adminClearOtpLockoutHandler(
        makeCtx({ headers: { 'idempotency-key': validKey }, body }),
      );
      expect(res.status, `clear #${prior + 1} should succeed`).toBe(200);
      expect(state.clearCalls).toEqual([targetEmail]);
    }

    // The (MAX+1)th clear — MAX already applied — is rejected.
    state.priorClearCount = CLEAR_LOCKOUT_MAX_PER_TARGET_PER_DAY;
    state.clearCalls = [];
    state.discordCalls = [];
    state.storedSnapshot = null;
    const rejected = await adminClearOtpLockoutHandler(
      makeCtx({ headers: { 'idempotency-key': validKey }, body }),
    );
    expect(rejected.status).toBe(429);
    const rejBody = (await rejected.json()) as { code: string };
    expect(rejBody.code).toBe('OTP_LOCKOUT_CLEAR_RATE_EXCEEDED');
    // The rejected clear must NOT mutate the counter, fire an audit, or
    // burn an idempotency snapshot (so a later retry re-evaluates).
    expect(state.clearCalls).toHaveLength(0);
    expect(state.discordCalls).toHaveLength(0);
    expect(state.storedSnapshot).toBeNull();
  });

  it('is PER-TARGET: the cap counts the target userId’s own clear path (24h window)', async () => {
    state.priorClearCount = 0;
    const res = await adminClearOtpLockoutHandler(
      makeCtx({ userId: targetUserId, headers: { 'idempotency-key': validKey }, body }),
    );
    expect(res.status).toBe(200);
    // The count is scoped to THIS user's clear path — proving the cap is
    // per-target, not a global counter shared across accounts.
    expect(state.countCalls).toHaveLength(1);
    expect(state.countCalls[0]).toEqual({
      path: `/api/admin/users/${targetUserId}/clear-otp-lockout`,
      windowMs: CLEAR_LOCKOUT_WINDOW_MS,
    });
  });

  it('a DIFFERENT target with its own (empty) count still succeeds even when another user is capped', async () => {
    const otherUserId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    state.getUserByIdResult = { id: otherUserId, email: 'other@loop.test' };
    // The mocked count returns 0 for this fresh target (a real per-path
    // count would too — no prior clears against otherUserId's path).
    state.priorClearCount = 0;
    const res = await adminClearOtpLockoutHandler(
      makeCtx({ userId: otherUserId, headers: { 'idempotency-key': validKey }, body }),
    );
    expect(res.status).toBe(200);
    expect(state.countCalls[0]?.path).toBe(`/api/admin/users/${otherUserId}/clear-otp-lockout`);
    expect(state.clearCalls).toEqual(['other@loop.test']);
  });

  it('FAILS CLOSED (503) when the count query errors — no clear, no audit, no snapshot', async () => {
    state.countThrow = new Error('count query blew up');
    const res = await adminClearOtpLockoutHandler(
      makeCtx({ headers: { 'idempotency-key': validKey }, body }),
    );
    expect(res.status).toBe(503);
    const errBody = (await res.json()) as { code: string };
    expect(errBody.code).toBe('OTP_LOCKOUT_CLEAR_RATE_CHECK_UNAVAILABLE');
    // Fail-closed: the counter was NOT cleared, so an attacker gets no
    // free pass on a transient DB error.
    expect(state.clearCalls).toHaveLength(0);
    expect(state.discordCalls).toHaveLength(0);
    expect(state.storedSnapshot).toBeNull();
  });

  // SEC-clearotp: the count→check→clear must be atomic against a concurrent
  // distinct-idempotency-key burst aimed at the SAME target. This wiring
  // test proves the handler HONOURS the per-target advisory lock: a burst
  // loser (try-lock returns false) is rejected 409 and performs no clear,
  // never even reaching the cap count. (The real serialisation — that only
  // one of N concurrent requests wins the lock — is proven in the
  // admin-writes integration suite against real postgres.)
  it('SEC-clearotp: 409 without clearing when the per-target advisory lock is already held', async () => {
    state.tryLockLocked = false;
    const res = await adminClearOtpLockoutHandler(
      makeCtx({ headers: { 'idempotency-key': validKey }, body }),
    );
    expect(res.status).toBe(409);
    const errBody = (await res.json()) as { code: string };
    expect(errBody.code).toBe('OTP_LOCKOUT_CLEAR_CONCURRENT');
    // Fail-closed: no clear, no cap count consumed, no audit, no snapshot.
    expect(state.clearCalls).toHaveLength(0);
    expect(state.countCalls).toHaveLength(0);
    expect(state.discordCalls).toHaveLength(0);
    expect(state.storedSnapshot).toBeNull();
  });
});
