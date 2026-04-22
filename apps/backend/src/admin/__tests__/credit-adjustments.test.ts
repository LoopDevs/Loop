import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import { InsufficientBalanceError } from '../../credits/adjustments.js';

const state = vi.hoisted(() => ({
  applyArgs: null as null | Record<string, unknown>,
  applyResult: null as null | {
    id: string;
    userId: string;
    currency: string;
    amountMinor: bigint;
    priorBalanceMinor: bigint;
    newBalanceMinor: bigint;
    createdAt: Date;
  },
  applyThrow: null as Error | null,
  priorSnapshot: null as null | { status: number; body: Record<string, unknown>; createdAt: Date },
  storedSnapshot: null as null | Record<string, unknown>,
  discordCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../credits/adjustments.js', async () => {
  const actual = (await vi.importActual('../../credits/adjustments.js')) as Record<string, unknown>;
  return {
    ...actual,
    applyAdminCreditAdjustment: vi.fn(async (args: Record<string, unknown>) => {
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
  lookupIdempotencyKey: vi.fn(async () => state.priorSnapshot),
  storeIdempotencyKey: vi.fn(async (args: Record<string, unknown>) => {
    state.storedSnapshot = args;
  }),
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

import { adminCreditAdjustmentHandler } from '../credit-adjustments.js';

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
    id: 'ctx-1111-2222-3333-4444-555555555555',
    userId: targetUserId,
    currency: 'GBP',
    amountMinor: 200n,
    priorBalanceMinor: 1000n,
    newBalanceMinor: 1200n,
    createdAt: new Date('2026-04-22T09:00:00Z'),
  };
  state.applyThrow = null;
  state.priorSnapshot = null;
  state.storedSnapshot = null;
  state.discordCalls = [];
});

describe('adminCreditAdjustmentHandler', () => {
  it('400 when userId is not a uuid', async () => {
    const res = await adminCreditAdjustmentHandler(
      makeCtx({
        userId: 'not-a-uuid',
        headers: { 'idempotency-key': validKey },
        body: { amountMinor: '100', currency: 'GBP', reason: 'ok' },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when Idempotency-Key header is missing', async () => {
    const res = await adminCreditAdjustmentHandler(
      makeCtx({
        body: { amountMinor: '100', currency: 'GBP', reason: 'ok' },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('400 when Idempotency-Key is too short', async () => {
    const res = await adminCreditAdjustmentHandler(
      makeCtx({
        headers: { 'idempotency-key': 'short' },
        body: { amountMinor: '100', currency: 'GBP', reason: 'ok' },
      }),
    );
    expect(res.status).toBe(400);
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
    const res = await adminCreditAdjustmentHandler(ctx);
    expect(res.status).toBe(400);
  });

  it('400 when amountMinor is zero', async () => {
    const res = await adminCreditAdjustmentHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { amountMinor: '0', currency: 'GBP', reason: 'ok' },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when reason is empty', async () => {
    const res = await adminCreditAdjustmentHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { amountMinor: '100', currency: 'GBP', reason: '' },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when currency is not a HOME_CURRENCY', async () => {
    const res = await adminCreditAdjustmentHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { amountMinor: '100', currency: 'JPY', reason: 'bad ccy' },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('happy path — returns envelope with result + audit, fires Discord, stores snapshot', async () => {
    const res = await adminCreditAdjustmentHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { amountMinor: '200', currency: 'GBP', reason: 'missed accrual from order o-1' },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: Record<string, unknown>;
      audit: Record<string, unknown>;
    };
    expect(body.result).toMatchObject({
      userId: targetUserId,
      currency: 'GBP',
      amountMinor: '200',
      priorBalanceMinor: '1000',
      newBalanceMinor: '1200',
      createdAt: '2026-04-22T09:00:00.000Z',
    });
    expect(body.audit).toMatchObject({
      actorUserId: adminUser.id,
      actorEmail: adminUser.email,
      idempotencyKey: validKey,
      appliedAt: '2026-04-22T09:00:00.000Z',
      replayed: false,
    });
    // Actor comes from c.get('user'), NOT body — apply called with
    // adminUserId from the context.
    expect(state.applyArgs).toMatchObject({
      userId: targetUserId,
      currency: 'GBP',
      adminUserId: adminUser.id,
    });
    // Discord fanout fired after commit with the right shape.
    expect(state.discordCalls).toHaveLength(1);
    expect(state.discordCalls[0]).toMatchObject({
      actorUserId: adminUser.id,
      targetUserId,
      amountMinor: '200',
      currency: 'GBP',
      reason: 'missed accrual from order o-1',
      idempotencyKey: validKey,
      replayed: false,
    });
    // Idempotency snapshot persisted.
    expect(state.storedSnapshot).not.toBeNull();
    expect(state.storedSnapshot!['key']).toBe(validKey);
    expect(state.storedSnapshot!['adminUserId']).toBe(adminUser.id);
  });

  it('handles negative amountMinor as a debit', async () => {
    state.applyResult = {
      id: 'ctx-deadbeef-0000-0000-0000-000000000000',
      userId: targetUserId,
      currency: 'GBP',
      amountMinor: -500n,
      priorBalanceMinor: 1000n,
      newBalanceMinor: 500n,
      createdAt: new Date('2026-04-22T10:00:00Z'),
    };
    const res = await adminCreditAdjustmentHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { amountMinor: '-500', currency: 'GBP', reason: 'duplicate credit reversal' },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: Record<string, unknown> };
    expect(body.result['amountMinor']).toBe('-500');
    expect(body.result['newBalanceMinor']).toBe('500');
  });

  it('409 on InsufficientBalance (debit below zero)', async () => {
    state.applyThrow = new InsufficientBalanceError('GBP', 100n, -500n);
    const res = await adminCreditAdjustmentHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { amountMinor: '-500', currency: 'GBP', reason: 'too aggressive debit' },
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INSUFFICIENT_BALANCE');
    expect(state.discordCalls).toHaveLength(0);
    expect(state.storedSnapshot).toBeNull();
  });

  it('500 when the repo throws an unexpected error', async () => {
    state.applyThrow = new Error('db exploded');
    const res = await adminCreditAdjustmentHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { amountMinor: '200', currency: 'GBP', reason: 'ok' },
      }),
    );
    expect(res.status).toBe(500);
    expect(state.storedSnapshot).toBeNull();
  });

  it('replays a prior snapshot on matching (actor, key) and does not call apply', async () => {
    const priorEnvelope = {
      result: {
        id: 'ctx-prior',
        userId: targetUserId,
        currency: 'GBP',
        amountMinor: '200',
        priorBalanceMinor: '1000',
        newBalanceMinor: '1200',
        createdAt: '2026-04-22T09:00:00.000Z',
      },
      audit: {
        actorUserId: adminUser.id,
        actorEmail: adminUser.email,
        idempotencyKey: validKey,
        appliedAt: '2026-04-22T09:00:00.000Z',
        replayed: false,
      },
    };
    state.priorSnapshot = {
      status: 200,
      body: priorEnvelope,
      createdAt: new Date(),
    };
    const res = await adminCreditAdjustmentHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { amountMinor: '200', currency: 'GBP', reason: 'replay attempt' },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: unknown; audit: { replayed: boolean } };
    expect(body.result).toEqual(priorEnvelope.result);
    expect(body.audit.replayed).toBe(false); // mirrors stored snapshot exactly
    // apply() should NOT have been called — the whole point.
    expect(state.applyArgs).toBeNull();
    // Discord was notified with replayed=true though — ops should
    // see the double-press in the channel.
    expect(state.discordCalls).toHaveLength(1);
    expect(state.discordCalls[0]).toMatchObject({ replayed: true });
  });

  it('401 when c.get("user") is missing (admin middleware bypass attempt)', async () => {
    const res = await adminCreditAdjustmentHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { amountMinor: '200', currency: 'GBP', reason: 'ok' },
        user: null,
      }),
    );
    expect(res.status).toBe(401);
  });

  it('applies the ledger reason from the body, not from any header', async () => {
    await adminCreditAdjustmentHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: {
          amountMinor: '200',
          currency: 'GBP',
          reason: 'ticket #1234: missed cashback on order o-1, user confirmed',
        },
      }),
    );
    expect(state.applyArgs!['reason']).toBe(
      'ticket #1234: missed cashback on order o-1, user confirmed',
    );
    expect(state.discordCalls[0]!['reason']).toBe(
      'ticket #1234: missed cashback on order o-1, user confirmed',
    );
  });
});
