import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { revokeAllMock, getUserByIdMock } = vi.hoisted(() => ({
  revokeAllMock: vi.fn(),
  getUserByIdMock: vi.fn(),
}));
vi.mock('../refresh-tokens.js', () => ({
  revokeAllRefreshTokensForUser: (userId: string) => revokeAllMock(userId),
}));
vi.mock('../../db/users.js', () => ({
  getUserById: (id: string) => getUserByIdMock(id),
}));

import {
  revokeAllOwnSessionsHandler,
  adminRevokeUserSessionsHandler,
} from '../revoke-sessions-handler.js';

const UID = '00000000-0000-4000-8000-000000000001';

function makeCtx(opts: {
  auth?: { kind: 'loop' | 'ctx'; userId?: string };
  user?: { id: string };
  param?: string;
}): Context {
  const store = new Map<string, unknown>();
  if (opts.auth !== undefined) store.set('auth', opts.auth);
  if (opts.user !== undefined) store.set('user', opts.user);
  return {
    req: { param: () => opts.param },
    get: (k: string) => store.get(k),
    json: (b: unknown, s?: number) => new Response(JSON.stringify(b), { status: s ?? 200 }),
  } as unknown as Context;
}

beforeEach(() => {
  revokeAllMock.mockReset();
  revokeAllMock.mockResolvedValue(undefined);
  getUserByIdMock.mockReset();
});

describe('revokeAllOwnSessionsHandler (self sign-out-all)', () => {
  it('revokes all refresh tokens for a loop-native caller', async () => {
    const res = await revokeAllOwnSessionsHandler(makeCtx({ auth: { kind: 'loop', userId: UID } }));
    expect(res.status).toBe(200);
    expect(revokeAllMock).toHaveBeenCalledWith(UID);
  });

  it('is a no-op success for a CTX-proxy caller (no local rows)', async () => {
    const res = await revokeAllOwnSessionsHandler(makeCtx({ auth: { kind: 'ctx' } }));
    expect(res.status).toBe(200);
    expect(revokeAllMock).not.toHaveBeenCalled();
  });

  it('401s with no auth context', async () => {
    const res = await revokeAllOwnSessionsHandler(makeCtx({}));
    expect(res.status).toBe(401);
    expect(revokeAllMock).not.toHaveBeenCalled();
  });

  it('500s (does not throw) when the revoke fails', async () => {
    revokeAllMock.mockRejectedValue(new Error('db down'));
    const res = await revokeAllOwnSessionsHandler(makeCtx({ auth: { kind: 'loop', userId: UID } }));
    expect(res.status).toBe(500);
  });
});

describe('adminRevokeUserSessionsHandler', () => {
  it('revokes the target user’s sessions', async () => {
    getUserByIdMock.mockResolvedValue({ id: UID });
    const res = await adminRevokeUserSessionsHandler(
      makeCtx({ user: { id: 'admin-1' }, param: UID }),
    );
    expect(res.status).toBe(200);
    expect(revokeAllMock).toHaveBeenCalledWith(UID);
  });

  it('400s on a non-uuid target', async () => {
    const res = await adminRevokeUserSessionsHandler(
      makeCtx({ user: { id: 'admin-1' }, param: 'not-a-uuid' }),
    );
    expect(res.status).toBe(400);
    expect(revokeAllMock).not.toHaveBeenCalled();
  });

  it('404s when the target user does not exist', async () => {
    getUserByIdMock.mockResolvedValue(null);
    const res = await adminRevokeUserSessionsHandler(
      makeCtx({ user: { id: 'admin-1' }, param: UID }),
    );
    expect(res.status).toBe(404);
    expect(revokeAllMock).not.toHaveBeenCalled();
  });

  it('500s when the revoke fails', async () => {
    getUserByIdMock.mockResolvedValue({ id: UID });
    revokeAllMock.mockRejectedValue(new Error('db down'));
    const res = await adminRevokeUserSessionsHandler(
      makeCtx({ user: { id: 'admin-1' }, param: UID }),
    );
    expect(res.status).toBe(500);
  });
});
