import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import type { LoopAuthContext } from '../../auth/handler.js';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

// Hoisted state the mocked user resolvers read from.
const { userState } = vi.hoisted(() => ({
  userState: {
    byId: null as unknown,
    upsertResult: null as unknown,
    upsertThrow: null as Error | null,
    upsertCalls: [] as Array<{ ctxUserId: string; email: string | undefined }>,
  },
}));

vi.mock('../../db/users.js', () => ({
  getUserById: vi.fn(async () => userState.byId),
  upsertUserFromCtx: vi.fn(async (args: { ctxUserId: string; email: string | undefined }) => {
    userState.upsertCalls.push(args);
    if (userState.upsertThrow !== null) throw userState.upsertThrow;
    return userState.upsertResult;
  }),
}));

// The handler decodes CTX bearers via auth/jwt decodeJwtPayload —
// stub it to return a preconfigured claim set.
const { jwtState } = vi.hoisted(() => ({
  jwtState: {
    claims: null as Record<string, unknown> | null,
  },
}));
vi.mock('../../auth/jwt.js', () => ({
  decodeJwtPayload: vi.fn(() => jwtState.claims),
}));

import { getMeHandler } from '../handler.js';

function makeCtx(auth: LoopAuthContext | undefined): Context {
  const store = new Map<string, unknown>();
  if (auth !== undefined) store.set('auth', auth);
  return {
    get: (k: string) => store.get(k),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  userState.byId = null;
  userState.upsertResult = null;
  userState.upsertThrow = null;
  userState.upsertCalls = [];
  jwtState.claims = null;
});

describe('getMeHandler', () => {
  it('401 when no auth is on the context', async () => {
    const res = await getMeHandler(makeCtx(undefined));
    expect(res.status).toBe(401);
  });

  it('resolves a Loop-native bearer via getUserById and returns the profile view', async () => {
    userState.byId = {
      id: 'loop-user-1',
      email: 'a@b.com',
      isAdmin: false,
      homeCurrency: 'GBP',
      ctxUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const res = await getMeHandler(
      makeCtx({
        kind: 'loop',
        userId: 'loop-user-1',
        email: 'a@b.com',
        bearerToken: 'loop-jwt',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      id: 'loop-user-1',
      email: 'a@b.com',
      isAdmin: false,
      homeCurrency: 'GBP',
    });
  });

  it('401 when the Loop bearer resolves no user row (deleted or unknown)', async () => {
    userState.byId = null;
    const res = await getMeHandler(
      makeCtx({
        kind: 'loop',
        userId: 'vanished-user',
        email: 'x@y.com',
        bearerToken: 'loop-jwt',
      }),
    );
    expect(res.status).toBe(401);
  });

  it('resolves a CTX bearer via upsertUserFromCtx and returns the profile view', async () => {
    jwtState.claims = { sub: 'ctx-123', email: 'ctx@example.com' };
    userState.upsertResult = {
      id: 'loop-2',
      email: 'ctx@example.com',
      isAdmin: true,
      homeCurrency: 'USD',
      ctxUserId: 'ctx-123',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const res = await getMeHandler(makeCtx({ kind: 'ctx', bearerToken: 'ctx-jwt' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      id: 'loop-2',
      email: 'ctx@example.com',
      isAdmin: true,
      homeCurrency: 'USD',
    });
    expect(userState.upsertCalls).toEqual([{ ctxUserId: 'ctx-123', email: 'ctx@example.com' }]);
  });

  it('401 when the CTX bearer is unreadable (decodeJwtPayload returns null)', async () => {
    jwtState.claims = null;
    const res = await getMeHandler(makeCtx({ kind: 'ctx', bearerToken: 'garbage' }));
    expect(res.status).toBe(401);
  });

  it('500 when the CTX upsert throws — surfaces a clean internal error', async () => {
    jwtState.claims = { sub: 'ctx-err', email: 'e@x.com' };
    userState.upsertThrow = new Error('db exploded');
    const res = await getMeHandler(makeCtx({ kind: 'ctx', bearerToken: 'ctx' }));
    expect(res.status).toBe(500);
  });

  it('omits the ctxUserId and timestamps from the view — only surface id/email/isAdmin/homeCurrency', async () => {
    userState.byId = {
      id: 'u',
      email: 'a@b.com',
      isAdmin: false,
      homeCurrency: 'EUR',
      ctxUserId: 'should-not-leak',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const res = await getMeHandler(
      makeCtx({ kind: 'loop', userId: 'u', email: 'a@b.com', bearerToken: 't' }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['email', 'homeCurrency', 'id', 'isAdmin']);
  });
});
