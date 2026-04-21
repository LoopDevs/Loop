import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so it runs before `env.ts` is imported — env.ts validates
// process.env at module-load and the allowlist is built once from it.
vi.hoisted(() => {
  process.env['ADMIN_CTX_USER_IDS'] = 'ctx-admin-1, ctx-admin-2';
});

const { dbMock, returned } = vi.hoisted(() => {
  const state = { row: null as unknown };
  const m: Record<string, ReturnType<typeof vi.fn>> = {};
  m['insert'] = vi.fn(() => m);
  m['values'] = vi.fn(() => m);
  m['onConflictDoUpdate'] = vi.fn(() => m);
  m['returning'] = vi.fn(async () => [state.row]);
  m['query'] = vi.fn(() => m) as unknown as ReturnType<typeof vi.fn>;
  return { dbMock: m, returned: state };
});

vi.mock('../client.js', () => ({
  db: {
    insert: dbMock['insert'],
    query: {
      users: {
        findFirst: vi.fn(async (_args: unknown) => returned.row ?? null),
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

import { upsertUserFromCtx, getUserById } from '../users.js';

beforeEach(() => {
  for (const fn of Object.values(dbMock)) {
    if (typeof fn === 'function' && 'mockClear' in fn) fn.mockClear();
  }
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
