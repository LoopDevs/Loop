import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as SchemaModule from '../../db/schema.js';

/**
 * Mock db with:
 *   - query.userIdentities.findFirst → controlled by state.identity
 *   - query.users.findFirst         → controlled by state.user
 *   - insert().values().returning() → returns state.insertedUser
 *   - insert().values().onConflictDoNothing() → no-op
 *   - db.transaction(cb) → cb(db) so we observe writes on the mock
 */
const { dbMock, state } = vi.hoisted(() => {
  const s: {
    identity: unknown;
    user: unknown;
    insertedUser: unknown;
    insertCalls: Array<{ table: string; values: unknown }>;
  } = { identity: undefined, user: undefined, insertedUser: null, insertCalls: [] };
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
  m['returning'] = vi.fn(async () => [s.insertedUser]);
  m['onConflictDoNothing'] = vi.fn(async () => undefined);
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
