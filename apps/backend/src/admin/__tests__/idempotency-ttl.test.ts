import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A2-500: focused tests for the 24h TTL surface —
 * `lookupIdempotencyKey` treats expired rows as a miss, and
 * `sweepStaleIdempotencyKeys` DELETEs them in bulk. The existing
 * `idempotency.test.ts` mocks `db.transaction` for the guard path;
 * this file mocks `db.query` + `db.delete` for the lookup + sweep
 * surfaces instead. Kept separate so each mock shape is narrow.
 */
const { dbMock, state } = vi.hoisted(() => {
  interface State {
    row: unknown;
    deletedRows: unknown[];
    lastDeleteWhereCutoff: Date | null;
    deleteErr: Error | null;
    insertedValues: unknown[];
    onConflictSet: unknown;
  }
  const s: State = {
    row: undefined,
    deletedRows: [],
    lastDeleteWhereCutoff: null,
    deleteErr: null,
    insertedValues: [],
    onConflictSet: undefined,
  };
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain['where'] = vi.fn((clause: { __lt?: { value?: Date } } | unknown) => {
    // The helper passes `lt(adminIdempotencyKeys.createdAt, cutoff)`
    // — the mock shape captures the cutoff so tests can assert on it.
    const asRecord = clause as { __lt?: { value?: Date } } | null;
    if (asRecord !== null && asRecord.__lt !== undefined) {
      s.lastDeleteWhereCutoff = asRecord.__lt.value ?? null;
    }
    return chain;
  });
  chain['returning'] = vi.fn(async () => {
    if (s.deleteErr !== null) throw s.deleteErr;
    return s.deletedRows;
  });
  chain['delete'] = vi.fn(() => chain);
  chain['insert'] = vi.fn(() => chain);
  chain['values'] = vi.fn((v: unknown) => {
    s.insertedValues.push(v);
    return chain;
  });
  chain['onConflictDoUpdate'] = vi.fn(async (arg: { set: unknown }) => {
    s.onConflictSet = arg.set;
  });
  const query = {
    adminIdempotencyKeys: {
      findFirst: vi.fn(async () => s.row),
    },
  };
  return {
    dbMock: {
      delete: chain['delete'],
      where: chain['where'],
      returning: chain['returning'],
      insert: chain['insert'],
      values: chain['values'],
      onConflictDoUpdate: chain['onConflictDoUpdate'],
      query,
    },
    state: s,
  };
});

vi.mock('../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../db/schema.js', () => ({
  adminIdempotencyKeys: {
    adminUserId: 'admin_user_id',
    key: 'key',
    createdAt: 'created_at',
  },
}));
vi.mock('drizzle-orm', async () => {
  const actual = (await vi.importActual('drizzle-orm')) as Record<string, unknown>;
  return {
    ...actual,
    and: (...c: unknown[]) => ({ __and: true, c }),
    eq: (_a: unknown, _b: unknown) => true,
    lt: (_a: unknown, value: unknown) => ({ __lt: { value } }),
  };
});
vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import {
  IDEMPOTENCY_TTL_HOURS,
  lookupIdempotencyKey,
  sweepStaleIdempotencyKeys,
  storeIdempotencyKey,
} from '../idempotency.js';

beforeEach(() => {
  state.row = undefined;
  state.deletedRows = [];
  state.lastDeleteWhereCutoff = null;
  state.deleteErr = null;
  state.insertedValues = [];
  state.onConflictSet = undefined;
});

describe('lookupIdempotencyKey — A2-500 TTL gate', () => {
  it('returns the snapshot for a row younger than the TTL', async () => {
    state.row = {
      status: 200,
      responseBody: JSON.stringify({ ok: true }),
      createdAt: new Date(Date.now() - 60_000),
    };
    const r = await lookupIdempotencyKey({ adminUserId: 'a', key: 'k' });
    expect(r).not.toBeNull();
    expect(r?.body).toEqual({ ok: true });
  });

  it('returns null for an expired row (older than TTL)', async () => {
    const ttlMs = IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000;
    state.row = {
      status: 200,
      responseBody: JSON.stringify({ ok: true }),
      createdAt: new Date(Date.now() - ttlMs - 60_000),
    };
    const r = await lookupIdempotencyKey({ adminUserId: 'a', key: 'k' });
    expect(r).toBeNull();
  });

  it('returns null when the row is absent', async () => {
    state.row = undefined;
    const r = await lookupIdempotencyKey({ adminUserId: 'a', key: 'k' });
    expect(r).toBeNull();
  });
});

describe('lookupIdempotencyKey — A2-1700 corrupt-JSON tolerance', () => {
  it('treats a corrupt stored snapshot (invalid JSON) as a miss', async () => {
    state.row = {
      status: 200,
      responseBody: '{not valid json',
      createdAt: new Date(),
    };
    const r = await lookupIdempotencyKey({ adminUserId: 'a', key: 'k' });
    expect(r).toBeNull();
  });
});

describe('storeIdempotencyKey — A2-1700', () => {
  it('serialises the body as JSON and inserts the (admin, key) pair', async () => {
    await storeIdempotencyKey({
      adminUserId: 'a-1',
      key: 'k'.repeat(32),
      method: 'POST',
      path: '/api/admin/credits/adjustments',
      status: 200,
      body: { result: { balance: 1000 }, audit: { replayed: false } },
    });
    expect(state.insertedValues).toHaveLength(1);
    expect(state.insertedValues[0]).toMatchObject({
      adminUserId: 'a-1',
      key: 'k'.repeat(32),
      method: 'POST',
      path: '/api/admin/credits/adjustments',
      status: 200,
      responseBody: JSON.stringify({
        result: { balance: 1000 },
        audit: { replayed: false },
      }),
    });
  });

  it('uses ON CONFLICT DO UPDATE with the same method/path/status/body fields', async () => {
    await storeIdempotencyKey({
      adminUserId: 'a-1',
      key: 'k'.repeat(32),
      method: 'POST',
      path: '/x',
      status: 201,
      body: { updated: true },
    });
    expect(state.onConflictSet).toMatchObject({
      method: 'POST',
      path: '/x',
      status: 201,
      responseBody: JSON.stringify({ updated: true }),
    });
  });

  it('serialises even an empty body deterministically', async () => {
    await storeIdempotencyKey({
      adminUserId: 'a-1',
      key: 'k'.repeat(32),
      method: 'POST',
      path: '/x',
      status: 200,
      body: {},
    });
    expect(state.insertedValues[0]).toMatchObject({ responseBody: '{}' });
  });
});

describe('sweepStaleIdempotencyKeys — A2-500 sweeper', () => {
  it('DELETEs rows older than the TTL and returns the count', async () => {
    state.deletedRows = [{ key: 'k-old-1' }, { key: 'k-old-2' }];
    const n = await sweepStaleIdempotencyKeys();
    expect(n).toBe(2);
    // Cutoff is ~24h in the past (±a few seconds of test drift).
    const now = Date.now();
    const expectedCutoff = now - IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000;
    expect(state.lastDeleteWhereCutoff).not.toBeNull();
    const drift = Math.abs((state.lastDeleteWhereCutoff as Date).getTime() - expectedCutoff);
    expect(drift).toBeLessThan(5_000);
  });

  it('returns 0 when nothing is stale', async () => {
    state.deletedRows = [];
    const n = await sweepStaleIdempotencyKeys();
    expect(n).toBe(0);
  });

  it('swallows DB errors and returns 0 — sweep is best-effort', async () => {
    state.deleteErr = new Error('deadlock');
    const n = await sweepStaleIdempotencyKeys();
    expect(n).toBe(0);
  });
});
