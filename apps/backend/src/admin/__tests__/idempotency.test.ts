// Admin idempotency guard — ADR 017, A2-2001, A2-500, NS-03
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db, __resetDbForTests } from '../../db/client.js';
import {
  countAppliedActionsForPath,
  lookupIdempotencyKey,
  storeIdempotencyKey,
  sweepStaleIdempotencyKeys,
  validateIdempotencyKey,
  withIdempotencyGuard,
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_TTL_HOURS,
} from '../idempotency.js';

vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

const ADMIN = 'admin-1';
const KEY = 'k'.repeat(IDEMPOTENCY_KEY_MIN);

beforeEach(() => {
  __resetDbForTests();
});

function guardArgs(
  overrides: Partial<Parameters<typeof withIdempotencyGuard>[0]> = {},
): Parameters<typeof withIdempotencyGuard>[0] {
  return {
    adminUserId: ADMIN,
    key: KEY,
    method: 'PUT',
    path: '/api/admin/staff/u-1/role',
    ...overrides,
  };
}

describe('validateIdempotencyKey', () => {
  it('rejects absent and short keys, accepts one at the minimum length', () => {
    expect(validateIdempotencyKey(undefined)).toBe(false);
    expect(validateIdempotencyKey('short')).toBe(false);
    expect(validateIdempotencyKey(KEY)).toBe(true);
  });
});

describe('withIdempotencyGuard', () => {
  it('runs the write once and replays the stored snapshot on a repeat', async () => {
    const write = vi.fn(async () => ({
      status: 200,
      body: { result: { ok: true }, audit: { replayed: false } } as Record<string, unknown>,
    }));

    const first = await withIdempotencyGuard(guardArgs(), write);
    const second = await withIdempotencyGuard(guardArgs(), write);

    expect(write).toHaveBeenCalledTimes(1);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.status).toBe(200);
    // ADR 017: guard flips replayed flag in stored body
    expect(second.body['audit']).toEqual({ replayed: true });
  });

  it('scopes the snapshot to the admin — the same key from another admin still executes', async () => {
    const write = vi.fn(async () => ({ status: 200, body: { n: 1 } }));
    await withIdempotencyGuard(guardArgs(), write);
    await withIdempotencyGuard(guardArgs({ adminUserId: 'admin-2' }), write);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('serialises concurrent callers so the write runs exactly once', async () => {
    let running = 0;
    let maxConcurrent = 0;
    const write = vi.fn(async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return { status: 200, body: { n: 1 } };
    });

    const results = await Promise.all([
      withIdempotencyGuard(guardArgs(), write),
      withIdempotencyGuard(guardArgs(), write),
      withIdempotencyGuard(guardArgs(), write),
    ]);

    expect(write).toHaveBeenCalledTimes(1);
    expect(maxConcurrent).toBe(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(2);
  });

  it('re-executes past the replay window but keeps the original audit timestamp', async () => {
    const write = vi.fn(async () => ({ status: 200, body: { n: 1 } }));
    await withIdempotencyGuard(guardArgs(), write);

    const createdAt = new Date(Date.now() - (IDEMPOTENCY_TTL_HOURS + 1) * 60 * 60 * 1000);
    await db
      .collection('admin_idempotency_keys')
      .updateOne({ adminUserId: ADMIN, key: KEY }, { $set: { createdAt } });

    const again = await withIdempotencyGuard(guardArgs(), write);

    expect(write).toHaveBeenCalledTimes(2);
    expect(again.replayed).toBe(false);
    // NS-03: row is the audit record, timestamp stays at first application
    const row = await db.collection('admin_idempotency_keys').findOne({ adminUserId: ADMIN });
    expect(row?.createdAt).toEqual(createdAt);
  });

  it('refuses to re-execute behind a corrupt snapshot', async () => {
    const write = vi.fn(async () => ({ status: 200, body: { n: 1 } }));
    await withIdempotencyGuard(guardArgs(), write);
    await db
      .collection('admin_idempotency_keys')
      .updateOne({ adminUserId: ADMIN, key: KEY }, { $set: { responseBody: 'not json' } });

    const result = await withIdempotencyGuard(guardArgs(), write);

    // Snapshot exists only if write committed; re-running would double side-effects
    expect(write).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(500);
    expect(result.body['code']).toBe('IDEMPOTENCY_SNAPSHOT_CORRUPT');
  });
});

describe('lookupIdempotencyKey', () => {
  it('reads a stored snapshot back and treats an expired row as a miss', async () => {
    await storeIdempotencyKey({
      adminUserId: ADMIN,
      key: KEY,
      method: 'PUT',
      path: '/p',
      status: 200,
      body: { n: 1 },
    });
    expect(await lookupIdempotencyKey({ adminUserId: ADMIN, key: KEY })).toMatchObject({
      status: 200,
      body: { n: 1 },
    });

    await db
      .collection('admin_idempotency_keys')
      .updateOne(
        { adminUserId: ADMIN, key: KEY },
        { $set: { createdAt: new Date(Date.now() - (IDEMPOTENCY_TTL_HOURS + 1) * 3600_000) } },
      );
    expect(await lookupIdempotencyKey({ adminUserId: ADMIN, key: KEY })).toBeNull();
  });
});

describe('countAppliedActionsForPath', () => {
  it('counts only applied actions on that exact path inside the window', async () => {
    const path = '/api/admin/users/u-1/clear-otp-lockout';
    await storeIdempotencyKey({
      adminUserId: ADMIN,
      key: 'a'.repeat(20),
      method: 'POST',
      path,
      status: 200,
      body: {},
    });
    await storeIdempotencyKey({
      adminUserId: ADMIN,
      key: 'b'.repeat(20),
      method: 'POST',
      path: '/api/admin/users/u-2/clear-otp-lockout',
      status: 200,
      body: {},
    });

    expect(await countAppliedActionsForPath({ path, windowMs: 60_000 })).toBe(1);
    expect(
      await countAppliedActionsForPath({
        path,
        windowMs: 60_000,
        now: new Date(Date.now() + 10 * 60_000),
      }),
    ).toBe(0);
  });
});

describe('sweepStaleIdempotencyKeys', () => {
  it('deletes rows past the retention window and keeps the rest', async () => {
    await storeIdempotencyKey({
      adminUserId: ADMIN,
      key: 'a'.repeat(20),
      method: 'POST',
      path: '/p',
      status: 200,
      body: {},
    });
    await db.collection('admin_idempotency_keys').insertOne({
      adminUserId: ADMIN,
      key: 'b'.repeat(20),
      method: 'POST',
      path: '/p',
      status: 200,
      responseBody: '{}',
      createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    });

    const deleted = await sweepStaleIdempotencyKeys({ retentionMs: 24 * 60 * 60 * 1000 });

    expect(deleted).toBe(1);
    expect(await db.collection('admin_idempotency_keys').count()).toBe(1);
  });
});
