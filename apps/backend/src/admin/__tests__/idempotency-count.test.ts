import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A5-3: focused tests for `countAppliedActionsForPath` — the per-target
 * velocity-cap primitive used by `clear-otp-lockout.ts`. Narrow mock
 * (just `db.select(...).from(...).where(...)`) kept separate from
 * `idempotency-ttl.test.ts`'s lookup/sweep/store mock, matching that
 * file's one-mock-shape-per-surface convention.
 */
const { dbMock, state } = vi.hoisted(() => {
  interface State {
    rows: Array<{ n: number }>;
    selectErr: Error | null;
    lastWhere: unknown;
  }
  const s: State = { rows: [], selectErr: null, lastWhere: null };
  const chain: Record<string, unknown> = {};
  chain['from'] = () => chain;
  chain['where'] = (clause: unknown) => {
    s.lastWhere = clause;
    if (s.selectErr !== null) return Promise.reject(s.selectErr);
    return Promise.resolve(s.rows);
  };
  return {
    dbMock: { select: () => chain },
    state: s,
  };
});

vi.mock('../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../db/schema.js', () => ({
  adminIdempotencyKeys: { path: 'path', createdAt: 'created_at' },
}));
vi.mock('drizzle-orm', async () => {
  const actual = (await vi.importActual('drizzle-orm')) as Record<string, unknown>;
  return {
    ...actual,
    and: (...c: unknown[]) => ({ __and: c }),
    eq: (col: unknown, value: unknown) => ({ __eq: { col, value } }),
    gt: (col: unknown, value: unknown) => ({ __gt: { col, value } }),
    lt: (col: unknown, value: unknown) => ({ __lt: { col, value } }),
    sql: Object.assign(() => ({ __sql: true }), { raw: () => ({ __sql: true }) }),
  };
});
vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { countAppliedActionsForPath } from '../idempotency.js';

beforeEach(() => {
  state.rows = [];
  state.selectErr = null;
  state.lastWhere = null;
});

describe('countAppliedActionsForPath (A5-3 per-target cap primitive)', () => {
  it('returns the counted rows for the exact path within the window', async () => {
    state.rows = [{ n: 3 }];
    const n = await countAppliedActionsForPath({
      path: '/api/admin/users/u-1/clear-otp-lockout',
      windowMs: 24 * 60 * 60 * 1000,
    });
    expect(n).toBe(3);
  });

  it('returns 0 when no rows match (never null/undefined)', async () => {
    state.rows = [];
    const n = await countAppliedActionsForPath({ path: '/x', windowMs: 1000 });
    expect(n).toBe(0);
  });

  it('filters on the exact path (eq) AND a createdAt lower bound (gt now-window)', async () => {
    state.rows = [{ n: 0 }];
    const now = new Date('2026-07-10T12:00:00.000Z');
    await countAppliedActionsForPath({
      path: '/api/admin/users/u-2/clear-otp-lockout',
      windowMs: 60_000,
      now,
    });
    const where = state.lastWhere as { __and: unknown[] };
    expect(where.__and).toBeDefined();
    const eqNode = where.__and.find(
      (c): c is { __eq: { value: unknown } } => typeof c === 'object' && c !== null && '__eq' in c,
    );
    const gtNode = where.__and.find(
      (c): c is { __gt: { value: Date } } => typeof c === 'object' && c !== null && '__gt' in c,
    );
    expect(eqNode?.__eq.value).toBe('/api/admin/users/u-2/clear-otp-lockout');
    // since = now - windowMs = 12:00:00 - 60s = 11:59:00.
    expect((gtNode?.__gt.value as Date).toISOString()).toBe('2026-07-10T11:59:00.000Z');
  });

  it('propagates a query error (caller fails closed) rather than swallowing it', async () => {
    state.selectErr = new Error('boom');
    await expect(countAppliedActionsForPath({ path: '/x', windowMs: 1000 })).rejects.toThrow(
      'boom',
    );
  });
});
