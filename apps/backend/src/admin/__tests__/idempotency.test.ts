import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Recursively walks `v` and pushes any bigint values into `out`.
 * Used to extract the pg_advisory_xact_lock param from drizzle's
 * sql-template representation without serialising (which blows up
 * on bigints in JSON).
 */
function extractBigints(v: unknown, out: bigint[]): void {
  if (typeof v === 'bigint') {
    out.push(v);
    return;
  }
  if (v === null || typeof v !== 'object') return;
  if (Array.isArray(v)) {
    for (const item of v) extractBigints(item, out);
    return;
  }
  for (const value of Object.values(v as Record<string, unknown>)) {
    extractBigints(value, out);
  }
}

/**
 * Mock the db so withIdempotencyGuard exercises its control flow
 * without a real Postgres. The transaction callback receives a `tx`
 * that:
 *   - exposes execute, query, insert, values, onConflictDoUpdate
 *   - captures the pg_advisory_xact_lock argument for assertion
 *   - returns state.priorRow from tx.query.adminIdempotencyKeys.findFirst
 */
const { dbMock, state } = vi.hoisted(() => {
  interface State {
    priorRow: unknown;
    advisoryLockCalls: bigint[];
    insertedSnapshots: unknown[];
    insertSet: unknown;
  }
  const s: State = {
    priorRow: undefined,
    advisoryLockCalls: [],
    insertedSnapshots: [],
    insertSet: undefined,
  };

  const tx: Record<string, ReturnType<typeof vi.fn>> = {};
  tx['execute'] = vi.fn(async (q: unknown) => {
    // The sql template is an object shape with params. Walk its
    // own-property values and pull out any BigInts we encounter —
    // the pg_advisory_xact_lock call passes our computed lock key
    // as a single bigint param.
    extractBigints(q, s.advisoryLockCalls);
    return [];
  });
  tx['query'] = {
    adminIdempotencyKeys: {
      findFirst: vi.fn(async () => s.priorRow),
    },
  } as unknown as ReturnType<typeof vi.fn>;
  tx['insert'] = vi.fn(() => tx);
  tx['values'] = vi.fn((v: unknown) => {
    s.insertedSnapshots.push(v);
    return tx;
  });
  tx['onConflictDoUpdate'] = vi.fn((arg: { set: unknown }) => {
    s.insertSet = arg.set;
    return tx;
  });

  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain['transaction'] = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx));

  return { dbMock: chain, state: s };
});

vi.mock('../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../db/schema.js', () => ({
  adminIdempotencyKeys: {
    adminUserId: 'admin_user_id',
    key: 'key',
    __name: 'adminIdempotencyKeys',
  },
}));

import {
  idempotencyLockKey,
  withIdempotencyGuard,
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  validateIdempotencyKey,
} from '../idempotency.js';

beforeEach(() => {
  state.priorRow = undefined;
  state.advisoryLockCalls = [];
  state.insertedSnapshots = [];
  state.insertSet = undefined;
});

describe('idempotencyLockKey', () => {
  it('returns a deterministic 64-bit signed bigint', () => {
    const k1 = idempotencyLockKey('admin-1', 'key-1');
    const k2 = idempotencyLockKey('admin-1', 'key-1');
    expect(k1).toBe(k2);
    // 64-bit signed range
    expect(k1).toBeGreaterThanOrEqual(-(2n ** 63n));
    expect(k1).toBeLessThan(2n ** 63n);
  });

  it('distinguishes different pairs', () => {
    expect(idempotencyLockKey('admin-1', 'a')).not.toBe(idempotencyLockKey('admin-1', 'b'));
    expect(idempotencyLockKey('admin-1', 'a')).not.toBe(idempotencyLockKey('admin-2', 'a'));
  });
});

describe('validateIdempotencyKey', () => {
  it('accepts keys within the min/max length band', () => {
    expect(validateIdempotencyKey('x'.repeat(IDEMPOTENCY_KEY_MIN))).toBe(true);
    expect(validateIdempotencyKey('x'.repeat(IDEMPOTENCY_KEY_MAX))).toBe(true);
  });
  it('rejects undefined and out-of-band lengths', () => {
    expect(validateIdempotencyKey(undefined)).toBe(false);
    expect(validateIdempotencyKey('x'.repeat(IDEMPOTENCY_KEY_MIN - 1))).toBe(false);
    expect(validateIdempotencyKey('x'.repeat(IDEMPOTENCY_KEY_MAX + 1))).toBe(false);
  });
});

describe('withIdempotencyGuard', () => {
  it('A2-2001: acquires an advisory lock before the snapshot lookup', async () => {
    await withIdempotencyGuard(
      { adminUserId: 'a-1', key: 'k-1', method: 'POST', path: '/x' },
      async () => ({ status: 200, body: { ok: true } }),
    );
    expect(state.advisoryLockCalls).toHaveLength(1);
    expect(state.advisoryLockCalls[0]).toBe(idempotencyLockKey('a-1', 'k-1'));
  });

  it('calls doWrite + stores snapshot when no prior row exists', async () => {
    state.priorRow = undefined;
    const doWrite = vi.fn(async () => ({ status: 200, body: { result: 'fresh' } }));
    const r = await withIdempotencyGuard(
      { adminUserId: 'a-1', key: 'k-1', method: 'POST', path: '/x' },
      doWrite,
    );
    expect(doWrite).toHaveBeenCalledTimes(1);
    expect(r.replayed).toBe(false);
    expect(r.body).toEqual({ result: 'fresh' });
    expect(state.insertedSnapshots).toHaveLength(1);
    expect(state.insertedSnapshots[0]).toMatchObject({
      adminUserId: 'a-1',
      key: 'k-1',
      responseBody: JSON.stringify({ result: 'fresh' }),
    });
  });

  it('replays prior snapshot without calling doWrite', async () => {
    state.priorRow = {
      status: 200,
      responseBody: JSON.stringify({ result: 'prior' }),
      createdAt: new Date(),
    };
    const doWrite = vi.fn(async () => ({ status: 200, body: { result: 'should-not-run' } }));
    const r = await withIdempotencyGuard(
      { adminUserId: 'a-1', key: 'k-1', method: 'POST', path: '/x' },
      doWrite,
    );
    expect(doWrite).not.toHaveBeenCalled();
    expect(r.replayed).toBe(true);
    expect(r.body).toEqual({ result: 'prior' });
  });

  it('treats a corrupt snapshot (invalid JSON) as a miss and re-runs doWrite', async () => {
    state.priorRow = {
      status: 200,
      responseBody: '{not valid json',
      createdAt: new Date(),
    };
    const doWrite = vi.fn(async () => ({ status: 200, body: { result: 'recovered' } }));
    const r = await withIdempotencyGuard(
      { adminUserId: 'a-1', key: 'k-1', method: 'POST', path: '/x' },
      doWrite,
    );
    expect(doWrite).toHaveBeenCalledTimes(1);
    expect(r.replayed).toBe(false);
    expect(r.body).toEqual({ result: 'recovered' });
  });

  it('propagates doWrite rejections (the lock releases via rollback)', async () => {
    const err = new Error('write failed');
    const doWrite = vi.fn(async () => {
      throw err;
    });
    await expect(
      withIdempotencyGuard({ adminUserId: 'a-1', key: 'k-1', method: 'POST', path: '/x' }, doWrite),
    ).rejects.toBe(err);
    // No snapshot stored on failure.
    expect(state.insertedSnapshots).toHaveLength(0);
  });
});
