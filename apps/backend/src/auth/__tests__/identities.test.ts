import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as SchemaModule from '../../db/schema.js';

// CF-30: set the native-auth admin allowlist before env.ts loads — the
// `isAdminEmail` allowlist (db/users.ts) is built once at module load.
// `apple-admin@loop.com` and `google-admin@loop.com` are the two
// allowlisted social emails exercised below (case-insensitive match).
vi.hoisted(() => {
  process.env['ADMIN_EMAILS'] = 'apple-admin@loop.com, google-admin@loop.com';
});

/**
 * Mock db with:
 *   - query.userIdentities.findFirst → controlled by state.identity
 *   - query.users.findFirst         → controlled by state.user
 *   - insert().values().returning() → returns state.insertedUser
 *   - insert().values().onConflictDoNothing() → no-op
 *   - update().set().where().returning() → CF-30 reconcileAdmin path
 *   - db.transaction(cb) → cb(db) so we observe writes on the mock
 */
const { dbMock, state } = vi.hoisted(() => {
  const s: {
    identity: unknown;
    user: unknown;
    insertedUser: unknown;
    insertCalls: Array<{ table: string; values: unknown }>;
    updateSet: unknown;
    updateReturns: unknown;
  } = {
    identity: undefined,
    user: undefined,
    insertedUser: null,
    insertCalls: [],
    updateSet: null,
    updateReturns: null,
  };
  const m: Record<string, ReturnType<typeof vi.fn>> = {};
  let lastInsertTable = '';
  m['insert'] = vi.fn((table: unknown) => {
    const tag = (table as Record<string, unknown>)['__name'];
    lastInsertTable = typeof tag === 'string' ? tag : '';
    return m;
  });
  m['values'] = vi.fn((v: unknown) => {
    s.insertCalls.push({ table: lastInsertTable, values: v });
    return m;
  });
  m['returning'] = vi.fn(async () => (s.insertedUser === null ? [] : [s.insertedUser]));
  m['onConflictDoNothing'] = vi.fn(() => m);
  // CF-30 config-parity reconcile (reconcileAdmin) runs on the OUTER db
  // (not the tx) via update().set().where().returning(). Capture the
  // set() payload and return state.updateReturns.
  m['update'] = vi.fn(() => ({
    set: vi.fn((v: unknown) => {
      s.updateSet = v;
      return { where: vi.fn(() => ({ returning: vi.fn(async () => [s.updateReturns]) })) };
    }),
  }));
  // A2-570: the inserted-user re-SELECT path needs a `tx.query.users.findFirst`
  // mock — the transaction callback receives the same `m` mock object, so we
  // attach a `query` property here. Returns whatever state.user has set.
  m['query'] = {
    userIdentities: { findFirst: vi.fn(async () => s.identity) },
    users: { findFirst: vi.fn(async () => s.user) },
  } as unknown as ReturnType<typeof vi.fn>;
  m['transaction'] = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(m));
  // select is overridden per-test for listLinkedIdentities; default
  // is a chain that resolves empty.
  m['select'] = vi.fn(() => ({
    from: () => ({ where: async () => [] }),
  })) as unknown as ReturnType<typeof vi.fn>;
  return { dbMock: m, state: s };
});

vi.mock('../../db/client.js', () => ({
  db: {
    ...dbMock,
    query: {
      userIdentities: {
        findFirst: vi.fn(async () => state.identity),
      },
      users: {
        findFirst: vi.fn(async () => state.user),
      },
    },
  },
}));
vi.mock('../../db/schema.js', async () => {
  const actual = await vi.importActual<typeof SchemaModule>('../../db/schema.js');
  return {
    ...actual,
    userIdentities: {
      userId: 'user_id',
      provider: 'provider',
      providerSub: 'provider_sub',
      emailAtLink: 'email_at_link',
      createdAt: 'created_at',
      __name: 'userIdentities',
    },
    users: {
      id: 'id',
      email: 'email',
      __name: 'users',
    },
  };
});

import { resolveOrCreateUserForIdentity, listLinkedIdentities } from '../identities.js';

beforeEach(() => {
  state.identity = undefined;
  state.user = undefined;
  state.insertedUser = null;
  state.insertCalls = [];
  state.updateSet = null;
  state.updateReturns = null;
  for (const fn of Object.values(dbMock)) {
    if (typeof fn === 'function' && 'mockClear' in fn) {
      (fn as unknown as { mockClear: () => void }).mockClear();
    }
  }
});

describe('resolveOrCreateUserForIdentity', () => {
  it('step 1 — known (provider, sub) → returns the existing user', async () => {
    state.identity = { userId: 'u-1', providerSub: 'sub-1', provider: 'google' };
    state.user = { id: 'u-1', email: 'a@b.com', isAdmin: false };
    const out = await resolveOrCreateUserForIdentity({
      provider: 'google',
      providerSub: 'sub-1',
      email: 'a@b.com',
    });
    expect(out.created).toBe(false);
    expect(out.user.id).toBe('u-1');
    // No inserts.
    expect(state.insertCalls).toHaveLength(0);
  });

  it('step 2 — unknown identity, known email → links provider to existing user', async () => {
    state.identity = undefined;
    state.user = { id: 'u-2', email: 'same@b.com', isAdmin: false };
    const out = await resolveOrCreateUserForIdentity({
      provider: 'google',
      providerSub: 'sub-new',
      email: 'SAME@B.COM',
    });
    expect(out.created).toBe(false);
    expect(out.user.id).toBe('u-2');
    expect(state.insertCalls).toHaveLength(1);
    expect(state.insertCalls[0]!.table).toBe('userIdentities');
    const values = state.insertCalls[0]!.values as Record<string, unknown>;
    expect(values['userId']).toBe('u-2');
    expect(values['provider']).toBe('google');
    expect(values['providerSub']).toBe('sub-new');
    // Email is lower-cased before persist.
    expect(values['emailAtLink']).toBe('same@b.com');
  });

  it('step 3 — unknown both → inserts users + user_identities (created=true)', async () => {
    state.identity = undefined;
    state.user = undefined;
    state.insertedUser = { id: 'u-3', email: 'fresh@b.com', isAdmin: false };
    const out = await resolveOrCreateUserForIdentity({
      provider: 'apple',
      providerSub: 'apple-sub',
      email: 'Fresh@B.com',
    });
    expect(out.created).toBe(true);
    expect(out.user.id).toBe('u-3');
    // Two inserts in order: users, then user_identities.
    expect(state.insertCalls).toHaveLength(2);
    expect(state.insertCalls[0]!.table).toBe('users');
    expect(state.insertCalls[1]!.table).toBe('userIdentities');
    // Lower-cased email on both.
    const userValues = state.insertCalls[0]!.values as Record<string, unknown>;
    expect(userValues['email']).toBe('fresh@b.com');
    const identityValues = state.insertCalls[1]!.values as Record<string, unknown>;
    expect(identityValues['provider']).toBe('apple');
    expect(identityValues['emailAtLink']).toBe('fresh@b.com');
  });

  it('step 3 — transaction boundary is used (rollback-safe)', async () => {
    state.identity = undefined;
    state.user = undefined;
    state.insertedUser = { id: 'u-4', email: 'x@b.com', isAdmin: false };
    await resolveOrCreateUserForIdentity({
      provider: 'google',
      providerSub: 's',
      email: 'x@b.com',
    });
    expect(dbMock['transaction']!).toHaveBeenCalled();
  });

  it('step 1 but user is missing — drops to step 3', async () => {
    state.identity = { userId: 'u-dead', providerSub: 'sub', provider: 'google' };
    state.user = undefined; // Dangling identity.
    state.insertedUser = { id: 'u-new', email: 'z@b.com', isAdmin: false };
    const out = await resolveOrCreateUserForIdentity({
      provider: 'google',
      providerSub: 'sub',
      email: 'z@b.com',
    });
    expect(out.created).toBe(true);
    expect(out.user.id).toBe('u-new');
  });

  it('A2-570: step 3 race — onConflictDoNothing + re-SELECT yields the winning row, created=false', async () => {
    // Two parallel social signups for the same brand-new email both
    // miss the step-2 SELECT and reach step 3. The losing INSERT
    // returns [] (ON CONFLICT DO NOTHING), then the re-SELECT inside
    // the transaction picks up the winner's row.
    state.identity = undefined;
    state.user = undefined; // step-2 pre-tx SELECT misses (uses outer mock).
    state.insertedUser = null; // INSERT inside step 3 returns empty (ON CONFLICT DO NOTHING).
    // The in-transaction re-SELECT runs against `tx.query.users.findFirst`
    // — that's the inner `m['query']` mock, separate from the outer
    // `db.query.users.findFirst`. Override the inner mock once so it
    // returns the winning row that a parallel caller inserted.
    const winningRow = { id: 'u-winning', email: 'raced@b.com', isAdmin: false };
    const txUsersFindFirst = (
      dbMock['query'] as unknown as {
        users: { findFirst: ReturnType<typeof vi.fn> };
      }
    ).users.findFirst;
    txUsersFindFirst.mockResolvedValueOnce(winningRow);
    const out = await resolveOrCreateUserForIdentity({
      provider: 'google',
      providerSub: 'sub-r',
      email: 'RACED@b.com',
    });
    expect(out.user).toEqual(winningRow);
    // `created` reports honestly — this caller did NOT do the user
    // insert (it was a no-op via ON CONFLICT).
    expect(out.created).toBe(false);
    // Two insert calls: the racy users-insert + the identity link.
    expect(state.insertCalls).toHaveLength(2);
    expect(state.insertCalls[0]!.table).toBe('users');
    expect(state.insertCalls[1]!.table).toBe('userIdentities');
  });

  // ── CF-30: native-auth admin grant on the social path ──────────────
  it('CF-30: step 3 (new user) inserts isAdmin=true for an allowlisted verified email', async () => {
    state.identity = undefined;
    state.user = undefined;
    state.insertedUser = {
      id: 'u-admin',
      email: 'apple-admin@loop.com',
      isAdmin: true,
    };
    const out = await resolveOrCreateUserForIdentity({
      provider: 'apple',
      providerSub: 'apple-admin-sub',
      // Mixed case — must still match the allowlist.
      email: 'Apple-Admin@Loop.com',
    });
    expect(out.created).toBe(true);
    expect(out.user.isAdmin).toBe(true);
    const userValues = state.insertCalls[0]!.values as Record<string, unknown>;
    expect(userValues['email']).toBe('apple-admin@loop.com');
    expect(userValues['isAdmin']).toBe(true);
  });

  it('CF-30: step 3 (new user) inserts isAdmin=false for a non-allowlisted email', async () => {
    state.identity = undefined;
    state.user = undefined;
    state.insertedUser = { id: 'u-plain', email: 'plain@loop.com', isAdmin: false };
    await resolveOrCreateUserForIdentity({
      provider: 'google',
      providerSub: 'plain-sub',
      email: 'plain@loop.com',
    });
    const userValues = state.insertCalls[0]!.values as Record<string, unknown>;
    expect(userValues['isAdmin']).toBe(false);
  });

  it('CF-30: step 1 (known identity) reconciles a stale non-admin row when now allowlisted', async () => {
    state.identity = { userId: 'u-g', providerSub: 'g-sub', provider: 'google' };
    // Row predates the grant → isAdmin=false; email now allowlisted.
    state.user = { id: 'u-g', email: 'google-admin@loop.com', isAdmin: false };
    state.updateReturns = { id: 'u-g', email: 'google-admin@loop.com', isAdmin: true };
    const out = await resolveOrCreateUserForIdentity({
      provider: 'google',
      providerSub: 'g-sub',
      email: 'google-admin@loop.com',
    });
    expect(out.user.isAdmin).toBe(true);
    expect(dbMock['update']!).toHaveBeenCalled();
    expect(state.updateSet).toEqual(expect.objectContaining({ isAdmin: true }));
  });

  it('CF-30: step 2 (email link) reconciles a stale admin row when no longer allowlisted', async () => {
    state.identity = undefined;
    // Email NOT on the allowlist but the row is flagged admin (grant
    // was revoked in config) → demote on next verified login.
    state.user = { id: 'u-stale', email: 'ex-admin@loop.com', isAdmin: true };
    state.updateReturns = { id: 'u-stale', email: 'ex-admin@loop.com', isAdmin: false };
    const out = await resolveOrCreateUserForIdentity({
      provider: 'apple',
      providerSub: 'ex-sub',
      email: 'ex-admin@loop.com',
    });
    expect(out.user.isAdmin).toBe(false);
    expect(state.updateSet).toEqual(expect.objectContaining({ isAdmin: false }));
  });

  it('CF-30: no reconcile write when the existing row already matches the allowlist', async () => {
    state.identity = { userId: 'u-ok', providerSub: 'ok-sub', provider: 'google' };
    state.user = { id: 'u-ok', email: 'google-admin@loop.com', isAdmin: true };
    const out = await resolveOrCreateUserForIdentity({
      provider: 'google',
      providerSub: 'ok-sub',
      email: 'google-admin@loop.com',
    });
    expect(out.user.isAdmin).toBe(true);
    expect(dbMock['update']!).not.toHaveBeenCalled();
  });
});

describe('listLinkedIdentities', () => {
  it('returns the linked providers for a user', async () => {
    dbMock['select']!.mockReturnValueOnce({
      from: () => ({
        where: async () => [
          {
            provider: 'google',
            providerSub: 'sub-1',
            emailAtLink: 'a@b.com',
            createdAt: new Date('2026-04-21T00:00:00Z'),
          },
        ],
      }),
    } as never);
    const rows = await listLinkedIdentities('u-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe('google');
    expect(rows[0]!.emailAtLink).toBe('a@b.com');
  });

  it('returns an empty array when the user has no linked identities', async () => {
    const rows = await listLinkedIdentities('u-empty');
    expect(rows).toEqual([]);
  });
});
