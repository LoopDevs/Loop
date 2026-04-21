import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.hoisted(() => {
  process.env['LOOP_JWT_SIGNING_KEY'] = 'k'.repeat(32);
});

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { requireAuth, type LoopAuthContext } from '../handler.js';
import { signLoopToken } from '../tokens.js';

interface FakeCtx {
  store: Map<string, unknown>;
  headers: Record<string, string | undefined>;
  ctx: Context;
}

function makeCtx(headers: Record<string, string | undefined>): FakeCtx {
  const store = new Map<string, unknown>();
  const fake: FakeCtx = {
    store,
    headers,
    ctx: {
      req: {
        header: (name: string) => headers[name] ?? headers[name.toLowerCase()],
      },
      get: (k: string) => store.get(k),
      set: (k: string, v: unknown) => store.set(k, v),
      json: (b: unknown, status?: number) =>
        new Response(JSON.stringify(b), {
          status: status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
    } as unknown as Context,
  };
  return fake;
}

beforeEach(() => {
  // Ensure the module reads the signing key we set up-front.
});

describe('requireAuth', () => {
  it('401 when the Authorization header is missing', async () => {
    const fake = makeCtx({});
    const next = vi.fn();
    const res = (await requireAuth(fake.ctx, next)) as Response;
    expect(res.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('401 when the header does not use Bearer', async () => {
    const fake = makeCtx({ Authorization: 'Basic abc' });
    const res = (await requireAuth(fake.ctx, vi.fn())) as Response;
    expect(res.status).toBe(401);
  });

  it('accepts a valid Loop access token and sets loop-kind auth', async () => {
    const { token } = signLoopToken({
      sub: 'user-uuid',
      email: 'a@b.com',
      typ: 'access',
      ttlSeconds: 300,
    });
    const fake = makeCtx({ Authorization: `Bearer ${token}` });
    const next = vi.fn().mockResolvedValue(undefined);
    await requireAuth(fake.ctx, next);
    expect(next).toHaveBeenCalledOnce();
    const auth = fake.store.get('auth') as LoopAuthContext;
    expect(auth.kind).toBe('loop');
    if (auth.kind === 'loop') {
      expect(auth.userId).toBe('user-uuid');
      expect(auth.email).toBe('a@b.com');
    }
    expect(fake.store.get('bearerToken')).toBe(token);
  });

  it('rejects an expired Loop token with a 401', async () => {
    const pastNow = Math.floor(Date.now() / 1000) - 10_000;
    const { token } = signLoopToken({
      sub: 'user-1',
      email: 'a@b.com',
      typ: 'access',
      ttlSeconds: 60,
      now: pastNow,
    });
    const fake = makeCtx({ Authorization: `Bearer ${token}` });
    const res = (await requireAuth(fake.ctx, vi.fn())) as Response;
    expect(res.status).toBe(401);
  });

  it('rejects a refresh token presented in the access slot', async () => {
    const { token } = signLoopToken({
      sub: 'user-1',
      email: 'a@b.com',
      typ: 'refresh',
      ttlSeconds: 300,
    });
    const fake = makeCtx({ Authorization: `Bearer ${token}` });
    const res = (await requireAuth(fake.ctx, vi.fn())) as Response;
    expect(res.status).toBe(401);
  });

  it('falls through to the CTX pass-through path for a non-Loop bearer', async () => {
    const ctxLike = 'header.payload.signature'; // looks like a JWT, not Loop-signed
    const fake = makeCtx({ Authorization: `Bearer ${ctxLike}` });
    const next = vi.fn().mockResolvedValue(undefined);
    await requireAuth(fake.ctx, next);
    expect(next).toHaveBeenCalledOnce();
    const auth = fake.store.get('auth') as LoopAuthContext;
    expect(auth.kind).toBe('ctx');
    expect(auth.bearerToken).toBe(ctxLike);
    expect(fake.store.get('bearerToken')).toBe(ctxLike);
  });

  it('honours an allowlisted X-Client-Id on the CTX pass-through', async () => {
    const fake = makeCtx({
      Authorization: 'Bearer opaque-ctx-token',
      'X-Client-Id': 'loopweb',
    });
    await requireAuth(fake.ctx, vi.fn().mockResolvedValue(undefined));
    expect(fake.store.get('clientId')).toBe('loopweb');
  });

  it('drops an untrusted X-Client-Id without failing the request', async () => {
    const fake = makeCtx({
      Authorization: 'Bearer opaque-ctx-token',
      'X-Client-Id': 'attacker-owned',
    });
    await requireAuth(fake.ctx, vi.fn().mockResolvedValue(undefined));
    expect(fake.store.get('clientId')).toBeUndefined();
  });
});
