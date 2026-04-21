import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const upsertMock = vi.fn();
const decodeMock = vi.fn();

vi.mock('../../db/users.js', () => ({
  upsertUserFromCtx: (args: unknown) => upsertMock(args),
}));
vi.mock('../jwt.js', () => ({
  decodeJwtPayload: (token: string) => decodeMock(token),
}));
vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

import { requireAdmin } from '../require-admin.js';

interface FakeCtx {
  bearer: string | undefined;
  userSet: unknown;
  ctx: Context;
}

function makeCtx(bearer: string | undefined): FakeCtx {
  const store = new Map<string, unknown>();
  if (bearer !== undefined) store.set('bearerToken', bearer);
  const fake: FakeCtx = {
    bearer,
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
  upsertMock.mockReset();
  decodeMock.mockReset();
});

describe('requireAdmin', () => {
  it('401 when no bearer token is present on context', async () => {
    const { ctx } = makeCtx(undefined);
    const res = (await requireAdmin(ctx, async () => {})) as Response;
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('401 when the bearer token cannot be decoded', async () => {
    decodeMock.mockReturnValue(null);
    const { ctx } = makeCtx('garbage');
    const res = (await requireAdmin(ctx, async () => {})) as Response;
    expect(res.status).toBe(401);
  });

  it('500 when the user upsert throws', async () => {
    decodeMock.mockReturnValue({ sub: 'u1', email: 'a@b.com' });
    upsertMock.mockRejectedValue(new Error('db down'));
    const { ctx } = makeCtx('tok');
    const res = (await requireAdmin(ctx, async () => {})) as Response;
    expect(res.status).toBe(500);
  });

  it('404 (not 403) when the user is authenticated but not admin', async () => {
    decodeMock.mockReturnValue({ sub: 'u1' });
    upsertMock.mockResolvedValue({ id: 'uuid', ctxUserId: 'u1', isAdmin: false });
    const { ctx } = makeCtx('tok');
    const res = (await requireAdmin(ctx, async () => {})) as Response;
    expect(res.status).toBe(404);
  });

  it('calls next and sets user on context when admin', async () => {
    const user = { id: 'uuid', ctxUserId: 'u1', isAdmin: true };
    decodeMock.mockReturnValue({ sub: 'u1', email: 'a@b.com' });
    upsertMock.mockResolvedValue(user);
    const next = vi.fn().mockResolvedValue(undefined);
    const fake = makeCtx('tok');
    await requireAdmin(fake.ctx, next);
    expect(next).toHaveBeenCalledOnce();
    expect(fake.userSet).toEqual(user);
    expect(upsertMock).toHaveBeenCalledWith({ ctxUserId: 'u1', email: 'a@b.com' });
  });

  it('passes undefined email when the claim is missing or non-string', async () => {
    decodeMock.mockReturnValue({ sub: 'u1', email: 42 });
    upsertMock.mockResolvedValue({ id: 'uuid', ctxUserId: 'u1', isAdmin: true });
    const { ctx } = makeCtx('tok');
    await requireAdmin(ctx, async () => {});
    expect(upsertMock).toHaveBeenCalledWith({ ctxUserId: 'u1', email: undefined });
  });
});
