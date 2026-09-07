import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { revokeAllMock } = vi.hoisted(() => ({
  revokeAllMock: vi.fn(),
}));
vi.mock('../refresh-tokens.js', () => ({
  revokeAllRefreshTokensForUser: (userId: string) => revokeAllMock(userId),
}));

import { revokeAllOwnSessionsHandler } from '../revoke-sessions-handler.js';

const UID = '00000000-0000-4000-8000-000000000001';

function makeCtx(opts: { auth?: { kind: 'loop' | 'ctx'; userId?: string } }): Context {
  const store = new Map<string, unknown>();
  if (opts.auth !== undefined) store.set('auth', opts.auth);
  return {
    get: (k: string) => store.get(k),
    json: (b: unknown, s?: number) => new Response(JSON.stringify(b), { status: s ?? 200 }),
  } as unknown as Context;
}

beforeEach(() => {
  revokeAllMock.mockReset();
  revokeAllMock.mockResolvedValue(undefined);
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
