import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const getUserByIdMock = vi.fn();

vi.mock('../../db/users.js', () => ({
  getUserById: (id: string) => getUserByIdMock(id),
}));
vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

import { requireAdmin } from '../require-admin.js';

interface FakeCtx {
  auth: unknown;
  userSet: unknown;
  ctx: Context;
}

function makeCtx(auth: unknown): FakeCtx {
  const store = new Map<string, unknown>();
  if (auth !== undefined) store.set('auth', auth);
  const fake: FakeCtx = {
    auth,
    userSet: undefined,
    ctx: {
      get: (k: string) => store.get(k),
      set: (k: string, v: unknown) => {
        store.set(k, v);
        if (k === 'user') fake.userSet = v;
      },
      json: (body: unknown, status?: number) =>
        new Response(JSON.stringify(body), {
          status: status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
    } as unknown as Context,
  };
  return fake;
}

beforeEach(() => {
  getUserByIdMock.mockReset();
});

describe('requireAdmin', () => {
  it('401 when no auth context is present', async () => {
    const { ctx } = makeCtx(undefined);
    const res = (await requireAdmin(ctx, async () => {})) as Response;
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('401 when the auth context is legacy ctx pass-through', async () => {
    const { ctx } = makeCtx({ kind: 'ctx', bearerToken: 'header.payload.sig' });
    const res = (await requireAdmin(ctx, async () => {})) as Response;
    expect(res.status).toBe(401);
  });

  it('401 when the verified loop token points at no user row', async () => {
    getUserByIdMock.mockResolvedValue(null);
    const { ctx } = makeCtx({ kind: 'loop', userId: 'u1', email: 'a@b.com', bearerToken: 'tok' });
    const res = (await requireAdmin(ctx, async () => {})) as Response;
    expect(res.status).toBe(401);
  });

  it('500 when user lookup throws', async () => {
    getUserByIdMock.mockRejectedValue(new Error('db down'));
    const { ctx } = makeCtx({ kind: 'loop', userId: 'u1', email: 'a@b.com', bearerToken: 'tok' });
    const res = (await requireAdmin(ctx, async () => {})) as Response;
    expect(res.status).toBe(500);
  });

  it('404 (not 403) when the user is authenticated but not admin', async () => {
    getUserByIdMock.mockResolvedValue({ id: 'uuid', isAdmin: false });
    const { ctx } = makeCtx({ kind: 'loop', userId: 'u1', email: 'a@b.com', bearerToken: 'tok' });
    const res = (await requireAdmin(ctx, async () => {})) as Response;
    expect(res.status).toBe(404);
  });

  it('calls next and sets user on context when admin', async () => {
    const user = { id: 'uuid', isAdmin: true };
    getUserByIdMock.mockResolvedValue(user);
    const next = vi.fn().mockResolvedValue(undefined);
    const fake = makeCtx({ kind: 'loop', userId: 'u1', email: 'a@b.com', bearerToken: 'tok' });
    await requireAdmin(fake.ctx, next);
    expect(next).toHaveBeenCalledOnce();
    expect(fake.userSet).toEqual(user);
    expect(getUserByIdMock).toHaveBeenCalledWith('u1');
  });
});
