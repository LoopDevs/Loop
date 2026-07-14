import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.hoisted(() => {
  process.env['LOOP_JWT_SIGNING_KEY'] = 'jwt-test-signing-key-32-chars-min!!';
});

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

// NS-09: requireAuth now reads the user's current token_version on the
// Loop-token path to enforce access-token revocation. Mock it so this
// unit suite doesn't need a live DB; `mockTokenVersion` / `throwOnRead`
// let each test drive the compare (match → accept, mismatch/null →
// reject, throw → 500).
let mockTokenVersion: number | null = 0;
let throwOnRead = false;
vi.mock('../../db/users.js', () => ({
  getUserTokenVersion: vi.fn(async () => {
    if (throwOnRead) throw new Error('db down');
    return mockTokenVersion;
  }),
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
  // NS-09: default the mocked token_version read to a matching value so
  // the pre-existing accept tests stay green; individual tests override.
  mockTokenVersion = 0;
  throwOnRead = false;
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

  it('accepts a valid Loop access token whose tv matches and sets loop-kind auth', async () => {
    mockTokenVersion = 3;
    const { token } = signLoopToken({
      sub: 'user-uuid',
      email: 'a@b.com',
      typ: 'access',
      ttlSeconds: 300,
      tv: 3,
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

  it('NS-09: rejects a token whose tv is stale (< current token_version) with 401', async () => {
    // Token minted at tv=0; the user's token_version was since bumped to
    // 1 (a logout / sign-out-all). The still-signed, still-unexpired
    // access token must now be rejected — the core NS-09 property.
    mockTokenVersion = 1;
    const { token } = signLoopToken({
      sub: 'user-uuid',
      email: 'a@b.com',
      typ: 'access',
      ttlSeconds: 300,
      tv: 0,
    });
    const fake = makeCtx({ Authorization: `Bearer ${token}` });
    const next = vi.fn();
    const res = (await requireAuth(fake.ctx, next)) as Response;
    expect(res.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('NS-09: fails a legacy access token with no tv claim closed (401)', async () => {
    // Pre-NS-09 token: valid signature + unexpired, but no `tv`. Must be
    // treated as a version mismatch, not silently honoured.
    mockTokenVersion = 0;
    const { token } = signLoopToken({
      sub: 'user-uuid',
      email: 'a@b.com',
      typ: 'access',
      ttlSeconds: 300,
      // no tv
    });
    const fake = makeCtx({ Authorization: `Bearer ${token}` });
    const next = vi.fn();
    const res = (await requireAuth(fake.ctx, next)) as Response;
    expect(res.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('NS-09: rejects a token whose user row no longer exists (401)', async () => {
    mockTokenVersion = null; // getUserTokenVersion → no row
    const { token } = signLoopToken({
      sub: 'ghost-user',
      email: 'a@b.com',
      typ: 'access',
      ttlSeconds: 300,
      tv: 0,
    });
    const fake = makeCtx({ Authorization: `Bearer ${token}` });
    const next = vi.fn();
    const res = (await requireAuth(fake.ctx, next)) as Response;
    expect(res.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('NS-09: fails closed with 500 when the token_version read throws', async () => {
    throwOnRead = true;
    const { token } = signLoopToken({
      sub: 'user-uuid',
      email: 'a@b.com',
      typ: 'access',
      ttlSeconds: 300,
      tv: 0,
    });
    const fake = makeCtx({ Authorization: `Bearer ${token}` });
    const next = vi.fn();
    const res = (await requireAuth(fake.ctx, next)) as Response;
    expect(res.status).toBe(500);
    expect(next).not.toHaveBeenCalled();
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
