import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so it runs before `env.ts` is imported — env.ts validates
// process.env at module-load and the allowlist is built once from it.
vi.hoisted(() => {
  process.env['ADMIN_CTX_USER_IDS'] = 'ctx-admin-1, ctx-admin-2';
});

const { dbMock, returned, findFirstMock } = vi.hoisted(() => {
  const state = { row: null as unknown };
  const m: Record<string, ReturnType<typeof vi.fn>> = {};
  m['insert'] = vi.fn(() => m);
  m['values'] = vi.fn(() => m);
  m['onConflictDoUpdate'] = vi.fn(() => m);
  m['onConflictDoNothing'] = vi.fn(() => m);
  m['returning'] = vi.fn(async () => [state.row]);
  m['query'] = vi.fn(() => m) as unknown as ReturnType<typeof vi.fn>;
  const findFirst = vi.fn(async (_args: unknown) => state.row ?? null);
  return { dbMock: m, returned: state, findFirstMock: findFirst };
});

vi.mock('../client.js', () => ({
  db: {
    insert: dbMock['insert'],
    query: {
      users: {
        findFirst: findFirstMock,
      },
    },
  },
}));
vi.mock('../schema.js', () => ({
  users: {
    id: 'id',
    ctxUserId: 'ctxUserId',
    email: 'email',
  },
}));

import { upsertUserFromCtx, getUserById, findOrCreateUserByEmail } from '../users.js';

beforeEach(() => {
  for (const fn of Object.values(dbMock)) {
    if (typeof fn === 'function' && 'mockClear' in fn) fn.mockClear();
  }
  findFirstMock.mockClear();
  returned.row = null;
});

describe('upsertUserFromCtx', () => {
  it('flags allowlisted CTX user ids as admin', async () => {
    returned.row = {
      id: 'uuid-1',
      ctxUserId: 'ctx-admin-1',
      email: 'a@b.com',
      isAdmin: true,
    };
    const user = await upsertUserFromCtx({ ctxUserId: 'ctx-admin-1', email: 'a@b.com' });
    expect(user.isAdmin).toBe(true);
    expect(dbMock['values']!).toHaveBeenCalledWith(
      expect.objectContaining({
        ctxUserId: 'ctx-admin-1',
        email: 'a@b.com',
        isAdmin: true,
      }),
    );
  });

  it('non-allowlisted users are inserted with isAdmin=false', async () => {
    returned.row = { id: 'uuid-2', ctxUserId: 'someone-else', email: '', isAdmin: false };
    await upsertUserFromCtx({ ctxUserId: 'someone-else', email: undefined });
    expect(dbMock['values']!).toHaveBeenCalledWith(
      expect.objectContaining({ isAdmin: false, email: '' }),
    );
  });

  it('throws when the insert returns no row', async () => {
    returned.row = undefined;
    await expect(upsertUserFromCtx({ ctxUserId: 'ctx-admin-2', email: undefined })).rejects.toThrow(
      /no row returned/,
    );
  });
});

describe('getUserById', () => {
  it('returns the row when found', async () => {
    returned.row = { id: 'uuid-3', ctxUserId: 'ctx', email: '', isAdmin: false };
    const row = await getUserById('uuid-3');
    expect(row).toEqual(returned.row);
  });

  it('returns null when findFirst resolves to undefined', async () => {
    returned.row = undefined;
    const row = await getUserById('missing');
    expect(row).toBeNull();
  });
});

describe('findOrCreateUserByEmail', () => {
  it('returns the existing row when the email is already known', async () => {
    returned.row = {
      id: 'uuid-e1',
      ctxUserId: null,
      email: 'a@b.com',
      isAdmin: false,
    };
    const user = await findOrCreateUserByEmail('A@B.COM');
    expect(user.id).toBe('uuid-e1');
    // No insert path taken.
    expect(dbMock['insert']!).not.toHaveBeenCalled();
  });

  it('inserts and returns a fresh row when the email is unknown', async () => {
    returned.row = null;
    const inserted = {
      id: 'uuid-e2',
      ctxUserId: null,
      email: 'new@b.com',
      isAdmin: false,
    };
    dbMock['returning']!.mockResolvedValueOnce([inserted]);
    const user = await findOrCreateUserByEmail('new@B.com');
    expect(user).toEqual(inserted);
    expect(dbMock['values']!).toHaveBeenCalledWith(expect.objectContaining({ email: 'new@b.com' }));
    // A2-706: INSERT uses onConflictDoNothing to absorb the signup
    // race when two concurrent verify-otp calls target the same
    // brand-new email.
    expect(dbMock['onConflictDoNothing']!).toHaveBeenCalled();
  });

  it('A2-706: re-selects the raced row when ON CONFLICT DO NOTHING absorbs the insert', async () => {
    // Concurrent signup scenario:
    //  1. findFirst → null (row not yet visible)
    //  2. INSERT ... ON CONFLICT DO NOTHING → [] (losing side)
    //  3. findFirst → the row the winning caller inserted
    const winningRow = {
      id: 'uuid-e3',
      ctxUserId: null,
      email: 'raced@b.com',
      isAdmin: false,
    };
    findFirstMock.mockResolvedValueOnce(null); // first pre-insert SELECT
    findFirstMock.mockResolvedValueOnce(winningRow); // re-SELECT after conflict
    dbMock['returning']!.mockResolvedValueOnce([]); // conflict — no row returned
    const user = await findOrCreateUserByEmail('RACED@b.com');
    expect(user).toEqual(winningRow);
    expect(findFirstMock).toHaveBeenCalledTimes(2);
  });

  it('throws when both the insert and the re-select return no row', async () => {
    // Pathological: conflict happens but the re-SELECT still misses
    // (could only occur if the row was deleted between steps 2 and 3).
    findFirstMock.mockResolvedValueOnce(null);
    findFirstMock.mockResolvedValueOnce(null);
    dbMock['returning']!.mockResolvedValueOnce([]);
    await expect(findOrCreateUserByEmail('x@y.com')).rejects.toThrow(
      /no row returned after conflict/,
    );
  });
});
