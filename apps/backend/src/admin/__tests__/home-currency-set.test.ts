import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import {
  HomeCurrencyConcurrentChangeError,
  HomeCurrencyHasInFlightPayoutsError,
  HomeCurrencyHasLiveBalanceError,
  HomeCurrencyUnchangedError,
  UserNotFoundError,
} from '../../users/home-currency-change.js';

const state = vi.hoisted(() => ({
  applyArgs: null as null | Record<string, unknown>,
  applyResult: null as null | {
    userId: string;
    priorHomeCurrency: 'USD' | 'GBP' | 'EUR';
    newHomeCurrency: 'USD' | 'GBP' | 'EUR';
    updatedAt: Date;
  },
  applyThrow: null as Error | null,
  priorSnapshot: null as null | { status: number; body: Record<string, unknown> },
  storedSnapshot: null as null | Record<string, unknown>,
  discordCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../users/home-currency-change.js', async () => {
  const actual = (await vi.importActual('../../users/home-currency-change.js')) as Record<
    string,
    unknown
  >;
  return {
    ...actual,
    applyAdminHomeCurrencyChange: vi.fn(async (args: Record<string, unknown>) => {
      state.applyArgs = args;
      if (state.applyThrow !== null) throw state.applyThrow;
      return state.applyResult;
    }),
  };
});

vi.mock('../idempotency.js', () => ({
  IDEMPOTENCY_KEY_MIN: 16,
  IDEMPOTENCY_KEY_MAX: 128,
  validateIdempotencyKey: (k: string | undefined): k is string =>
    k !== undefined && k.length >= 16 && k.length <= 128,
  withIdempotencyGuard: vi.fn(
    async (
      args: { adminUserId: string; key: string; method: string; path: string },
      doWrite: () => Promise<{ status: number; body: Record<string, unknown> }>,
    ) => {
      if (state.priorSnapshot !== null) {
        return {
          replayed: true,
          status: state.priorSnapshot.status,
          body: state.priorSnapshot.body,
        };
      }
      const { status, body } = await doWrite();
      state.storedSnapshot = {
        adminUserId: args.adminUserId,
        key: args.key,
        method: args.method,
        path: args.path,
        status,
        body,
      };
      return { replayed: false, status, body };
    },
  ),
}));

vi.mock('../../discord.js', () => ({
  notifyAdminAudit: vi.fn((args: Record<string, unknown>) => {
    state.discordCalls.push(args);
  }),
}));

vi.mock('../../db/schema.js', () => ({
  HOME_CURRENCIES: ['USD', 'GBP', 'EUR'] as const,
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminHomeCurrencySetHandler } from '../home-currency-set.js';

const adminUser = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'admin@loop.test',
  isAdmin: true,
  homeCurrency: 'GBP',
  stellarAddress: null,
  ctxUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const targetUserId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const validKey = 'k'.repeat(32);

function makeCtx(args: {
  userId?: string;
  headers?: Record<string, string>;
  body?: unknown;
  user?: typeof adminUser | null;
}): Context {
  const resolved = args.user === null ? undefined : (args.user ?? adminUser);
  const store = new Map<string, unknown>();
  if (resolved !== undefined) store.set('user', resolved);
  return {
    req: {
      param: (k: string) => (k === 'userId' ? (args.userId ?? targetUserId) : undefined),
      header: (k: string) => args.headers?.[k.toLowerCase()],
      json: async () => {
        if (args.body === undefined) throw new Error('no body');
        return args.body;
      },
    },
    get: (k: string) => store.get(k),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  state.applyArgs = null;
  state.applyResult = {
    userId: targetUserId,
    priorHomeCurrency: 'USD',
    newHomeCurrency: 'GBP',
    updatedAt: new Date('2026-05-04T12:00:00Z'),
  };
  state.applyThrow = null;
  state.priorSnapshot = null;
  state.storedSnapshot = null;
  state.discordCalls = [];
});

describe('adminHomeCurrencySetHandler', () => {
  it('400 when userId is not a uuid', async () => {
    const res = await adminHomeCurrencySetHandler(
      makeCtx({
        userId: 'not-a-uuid',
        headers: { 'idempotency-key': validKey },
        body: { homeCurrency: 'GBP', reason: 'support ticket #42' },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when Idempotency-Key header is missing', async () => {
    const res = await adminHomeCurrencySetHandler(
      makeCtx({ body: { homeCurrency: 'GBP', reason: 'ok' } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('401 when admin context is missing', async () => {
    const res = await adminHomeCurrencySetHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { homeCurrency: 'GBP', reason: 'ok' },
        user: null,
      }),
    );
    expect(res.status).toBe(401);
  });

  it('400 when the body is invalid JSON', async () => {
    const ctx = {
      req: {
        param: () => targetUserId,
        header: (k: string) => (k.toLowerCase() === 'idempotency-key' ? validKey : undefined),
        json: async () => {
          throw new Error('bad json');
        },
      },
      get: () => adminUser,
      json: (body: unknown, status?: number) =>
        new Response(JSON.stringify(body), {
          status: status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
    } as unknown as Context;
    const res = await adminHomeCurrencySetHandler(ctx);
    expect(res.status).toBe(400);
  });

  it('400 when homeCurrency is not in the enum', async () => {
    const res = await adminHomeCurrencySetHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { homeCurrency: 'JPY', reason: 'support' },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when reason is too short', async () => {
    const res = await adminHomeCurrencySetHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { homeCurrency: 'GBP', reason: '' },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('200 on a successful change with audit envelope', async () => {
    const res = await adminHomeCurrencySetHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { homeCurrency: 'GBP', reason: 'support ticket #42' },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        userId: string;
        priorHomeCurrency: string;
        newHomeCurrency: string;
        updatedAt: string;
      };
      audit: { actorUserId: string; idempotencyKey: string; replayed: boolean };
    };
    expect(body.result.userId).toBe(targetUserId);
    expect(body.result.priorHomeCurrency).toBe('USD');
    expect(body.result.newHomeCurrency).toBe('GBP');
    expect(body.audit.actorUserId).toBe(adminUser.id);
    expect(body.audit.replayed).toBe(false);
    expect(state.applyArgs).toEqual({ userId: targetUserId, newHomeCurrency: 'GBP' });
    expect(state.discordCalls).toHaveLength(1);
    expect(state.discordCalls[0]).toMatchObject({
      actorUserId: adminUser.id,
      targetUserId,
      reason: 'support ticket #42',
      idempotencyKey: validKey,
      replayed: false,
    });
  });

  it('replays the stored snapshot on idempotency-key reuse and re-fires Discord with replayed=true', async () => {
    state.priorSnapshot = {
      status: 200,
      body: {
        result: {
          userId: targetUserId,
          priorHomeCurrency: 'USD',
          newHomeCurrency: 'GBP',
          updatedAt: '2026-05-04T12:00:00.000Z',
        },
        audit: {
          actorUserId: adminUser.id,
          actorEmail: adminUser.email,
          idempotencyKey: validKey,
          appliedAt: '2026-05-04T12:00:00.000Z',
          replayed: false,
        },
      },
    };
    const res = await adminHomeCurrencySetHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { homeCurrency: 'GBP', reason: 'support' },
      }),
    );
    expect(res.status).toBe(200);
    expect(state.applyArgs).toBeNull();
    expect(state.discordCalls[0]?.replayed).toBe(true);
  });

  it('404 when target user does not exist', async () => {
    state.applyThrow = new UserNotFoundError(targetUserId);
    const res = await adminHomeCurrencySetHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { homeCurrency: 'GBP', reason: 'support' },
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('USER_NOT_FOUND');
    expect(state.discordCalls).toHaveLength(0);
  });

  it('409 when the new currency equals the current currency', async () => {
    state.applyThrow = new HomeCurrencyUnchangedError('GBP');
    const res = await adminHomeCurrencySetHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { homeCurrency: 'GBP', reason: 'support' },
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('HOME_CURRENCY_UNCHANGED');
  });

  it('409 when the user has a non-zero balance in the old currency', async () => {
    state.applyThrow = new HomeCurrencyHasLiveBalanceError('USD', 250n);
    const res = await adminHomeCurrencySetHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { homeCurrency: 'GBP', reason: 'support' },
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('HOME_CURRENCY_HAS_LIVE_BALANCE');
    expect(body.message).toContain('250');
    expect(body.message).toContain('USD');
  });

  it('409 when the user has in-flight payouts', async () => {
    state.applyThrow = new HomeCurrencyHasInFlightPayoutsError(2);
    const res = await adminHomeCurrencySetHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { homeCurrency: 'GBP', reason: 'support' },
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('HOME_CURRENCY_HAS_IN_FLIGHT_PAYOUTS');
    expect(body.message).toContain('2');
  });

  it('409 on concurrent change', async () => {
    state.applyThrow = new HomeCurrencyConcurrentChangeError();
    const res = await adminHomeCurrencySetHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { homeCurrency: 'GBP', reason: 'support' },
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('CONCURRENT_CHANGE');
  });

  it('500 on an unexpected error', async () => {
    state.applyThrow = new Error('boom');
    const res = await adminHomeCurrencySetHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { homeCurrency: 'GBP', reason: 'support' },
      }),
    );
    expect(res.status).toBe(500);
  });
});
