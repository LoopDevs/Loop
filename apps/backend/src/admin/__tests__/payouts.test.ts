import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../db/schema.js', () => ({
  PAYOUT_STATES: ['pending', 'submitted', 'confirmed', 'failed'] as const,
}));

const idempotencyState = vi.hoisted(() => ({
  priorSnapshot: null as null | { status: number; body: Record<string, unknown>; createdAt: Date },
  storedSnapshot: null as null | Record<string, unknown>,
  discordCalls: [] as Array<Record<string, unknown>>,
}));

const listMock = vi.fn();
const resetMock = vi.fn();
const getMock = vi.fn();
const byOrderMock = vi.fn();
vi.mock('../../credits/pending-payouts.js', () => ({
  listPayoutsForAdmin: (opts: unknown) => listMock(opts),
  resetPayoutToPending: (id: string) => resetMock(id),
  getPayoutForAdmin: (id: string) => getMock(id),
  getPayoutByOrderId: (orderId: string) => byOrderMock(orderId),
}));
vi.mock('../idempotency.js', () => ({
  IDEMPOTENCY_KEY_MIN: 16,
  IDEMPOTENCY_KEY_MAX: 128,
  validateIdempotencyKey: (k: string | undefined): k is string =>
    k !== undefined && k.length >= 16 && k.length <= 128,
  lookupIdempotencyKey: vi.fn(async () => idempotencyState.priorSnapshot),
  storeIdempotencyKey: vi.fn(async (args: Record<string, unknown>) => {
    idempotencyState.storedSnapshot = args;
  }),
}));
vi.mock('../../discord.js', () => ({
  notifyAdminAudit: vi.fn((args: Record<string, unknown>) => {
    idempotencyState.discordCalls.push(args);
  }),
}));
vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import {
  adminGetPayoutHandler,
  adminListPayoutsHandler,
  adminPayoutByOrderHandler,
  adminRetryPayoutHandler,
} from '../payouts.js';

function makeCtx(query: Record<string, string> = {}, params: Record<string, string> = {}): Context {
  return {
    req: {
      query: (k: string) => query[k],
      param: (k: string) => params[k],
    },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

const baseRow = {
  id: 'p-1',
  userId: 'u-1',
  orderId: 'o-1',
  assetCode: 'GBPLOOP',
  assetIssuer: 'GISSUER',
  toAddress: 'GDESTINATION',
  amountStroops: 50_000_000n,
  memoText: 'o-1',
  state: 'pending',
  txHash: null,
  lastError: null,
  attempts: 0,
  createdAt: new Date('2026-04-21T12:00:00Z'),
  submittedAt: null,
  confirmedAt: null,
  failedAt: null,
};

beforeEach(() => {
  listMock.mockReset();
  listMock.mockResolvedValue([baseRow]);
  resetMock.mockReset();
  getMock.mockReset();
  byOrderMock.mockReset();
});

describe('adminListPayoutsHandler', () => {
  it('returns the BigInt-safe view for a simple list', async () => {
    const res = await adminListPayoutsHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { payouts: Array<Record<string, unknown>> };
    expect(body.payouts).toHaveLength(1);
    expect(body.payouts[0]).toMatchObject({
      id: 'p-1',
      amountStroops: '50000000',
      createdAt: '2026-04-21T12:00:00.000Z',
    });
  });

  it('filters by ?state=failed when a valid state is given', async () => {
    await adminListPayoutsHandler(makeCtx({ state: 'failed' }));
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ state: 'failed' }));
  });

  it('400 when ?state is not in the enum', async () => {
    const res = await adminListPayoutsHandler(makeCtx({ state: 'rogue' }));
    expect(res.status).toBe(400);
  });

  it('defaults limit to 20 and clamps to 1..100', async () => {
    await adminListPayoutsHandler(makeCtx());
    expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 20 }));

    await adminListPayoutsHandler(makeCtx({ limit: '0' }));
    expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 1 }));

    await adminListPayoutsHandler(makeCtx({ limit: '999' }));
    expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 100 }));

    await adminListPayoutsHandler(makeCtx({ limit: 'not-a-number' }));
    expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 20 }));
  });

  it('accepts a well-formed before= timestamp', async () => {
    await adminListPayoutsHandler(makeCtx({ before: '2026-04-21T00:00:00Z' }));
    const call = listMock.mock.calls[0]![0] as { before?: Date };
    expect(call.before).toBeInstanceOf(Date);
    expect(call.before!.toISOString()).toBe('2026-04-21T00:00:00.000Z');
  });

  it('400 on malformed before= timestamp', async () => {
    const res = await adminListPayoutsHandler(makeCtx({ before: 'not-a-date' }));
    expect(res.status).toBe(400);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('forwards a valid userId to the repo', async () => {
    const uuid = '11111111-1111-1111-1111-111111111111';
    await adminListPayoutsHandler(makeCtx({ userId: uuid }));
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ userId: uuid }));
  });

  it('400 on malformed userId', async () => {
    const res = await adminListPayoutsHandler(makeCtx({ userId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('forwards a valid assetCode to the repo', async () => {
    await adminListPayoutsHandler(makeCtx({ assetCode: 'GBPLOOP' }));
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ assetCode: 'GBPLOOP' }));
  });

  it('400 on unknown assetCode', async () => {
    const res = await adminListPayoutsHandler(makeCtx({ assetCode: 'BOGUSLOOP' }));
    expect(res.status).toBe(400);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('400 on lowercase assetCode (strict uppercase per schema)', async () => {
    const res = await adminListPayoutsHandler(makeCtx({ assetCode: 'gbploop' }));
    expect(res.status).toBe(400);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('serialises nullable timestamps as null, populated as ISO strings', async () => {
    listMock.mockResolvedValue([
      {
        ...baseRow,
        state: 'confirmed',
        submittedAt: new Date('2026-04-21T13:00:00Z'),
        confirmedAt: new Date('2026-04-21T13:05:00Z'),
        txHash: 'abc',
      },
    ]);
    const res = await adminListPayoutsHandler(makeCtx());
    const body = (await res.json()) as { payouts: Array<Record<string, unknown>> };
    expect(body.payouts[0]!['submittedAt']).toBe('2026-04-21T13:00:00.000Z');
    expect(body.payouts[0]!['confirmedAt']).toBe('2026-04-21T13:05:00.000Z');
    expect(body.payouts[0]!['failedAt']).toBeNull();
    expect(body.payouts[0]!['txHash']).toBe('abc');
  });
});

describe('adminGetPayoutHandler', () => {
  const validId = '11111111-2222-3333-4444-555555555555';

  it('400 when id param is missing', async () => {
    const res = await adminGetPayoutHandler(makeCtx({}, {}));
    expect(res.status).toBe(400);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('400 when id is not a uuid', async () => {
    const res = await adminGetPayoutHandler(makeCtx({}, { id: 'not-a-uuid' }));
    expect(res.status).toBe(400);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('404 when the row is not found', async () => {
    getMock.mockResolvedValue(null);
    const res = await adminGetPayoutHandler(makeCtx({}, { id: validId }));
    expect(res.status).toBe(404);
    expect(getMock).toHaveBeenCalledWith(validId);
  });

  it('returns the BigInt-safe view on hit', async () => {
    getMock.mockResolvedValue({
      ...baseRow,
      id: validId,
      state: 'confirmed',
      submittedAt: new Date('2026-04-21T13:00:00Z'),
      confirmedAt: new Date('2026-04-21T13:05:00Z'),
      txHash: 'abc',
    });
    const res = await adminGetPayoutHandler(makeCtx({}, { id: validId }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: validId,
      state: 'confirmed',
      amountStroops: '50000000',
      submittedAt: '2026-04-21T13:00:00.000Z',
      confirmedAt: '2026-04-21T13:05:00.000Z',
      txHash: 'abc',
    });
  });

  it('500 when the repo throws', async () => {
    getMock.mockRejectedValue(new Error('db exploded'));
    const res = await adminGetPayoutHandler(makeCtx({}, { id: validId }));
    expect(res.status).toBe(500);
  });
});

describe('adminPayoutByOrderHandler', () => {
  const validOrderId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('400 when orderId param is missing', async () => {
    const res = await adminPayoutByOrderHandler(makeCtx({}, {}));
    expect(res.status).toBe(400);
    expect(byOrderMock).not.toHaveBeenCalled();
  });

  it('400 when orderId is not a uuid', async () => {
    const res = await adminPayoutByOrderHandler(makeCtx({}, { orderId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
    expect(byOrderMock).not.toHaveBeenCalled();
  });

  it('404 when the order has no payout row', async () => {
    byOrderMock.mockResolvedValue(null);
    const res = await adminPayoutByOrderHandler(makeCtx({}, { orderId: validOrderId }));
    expect(res.status).toBe(404);
    expect(byOrderMock).toHaveBeenCalledWith(validOrderId);
  });

  it('returns the BigInt-safe view on hit', async () => {
    byOrderMock.mockResolvedValue({
      ...baseRow,
      orderId: validOrderId,
      state: 'submitted',
      submittedAt: new Date('2026-04-21T13:00:00Z'),
    });
    const res = await adminPayoutByOrderHandler(makeCtx({}, { orderId: validOrderId }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      orderId: validOrderId,
      state: 'submitted',
      amountStroops: '50000000',
      submittedAt: '2026-04-21T13:00:00.000Z',
    });
  });

  it('500 when the repo throws', async () => {
    byOrderMock.mockRejectedValue(new Error('db exploded'));
    const res = await adminPayoutByOrderHandler(makeCtx({}, { orderId: validOrderId }));
    expect(res.status).toBe(500);
  });
});

describe('adminRetryPayoutHandler (ADR 017)', () => {
  const admin = {
    id: '11111111-1111-1111-1111-111111111111',
    email: 'admin@loop.test',
    isAdmin: true,
    homeCurrency: 'GBP',
    stellarAddress: null,
    ctxUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const payoutId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const validKey = 'k'.repeat(32);
  const resetRow = {
    ...baseRow,
    id: payoutId,
    userId: 'uuuuuuuu-1111-2222-3333-444444444444',
    state: 'pending',
    lastError: null,
  };

  function makeRetryCtx(args: {
    id?: string;
    headers?: Record<string, string>;
    body?: unknown;
    user?: typeof admin | null;
  }): Context {
    const resolved = args.user === null ? undefined : (args.user ?? admin);
    const store = new Map<string, unknown>();
    if (resolved !== undefined) store.set('user', resolved);
    return {
      req: {
        param: (k: string) => (k === 'id' ? (args.id ?? payoutId) : undefined),
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
    idempotencyState.priorSnapshot = null;
    idempotencyState.storedSnapshot = null;
    idempotencyState.discordCalls = [];
    resetMock.mockResolvedValue(resetRow);
  });

  it('400 when id is not a uuid', async () => {
    const res = await adminRetryPayoutHandler(
      makeRetryCtx({
        id: 'not-a-uuid',
        headers: { 'idempotency-key': validKey },
        body: { reason: 'r' },
      }),
    );
    expect(res.status).toBe(400);
    expect(resetMock).not.toHaveBeenCalled();
  });

  it('400 when Idempotency-Key header is missing', async () => {
    const res = await adminRetryPayoutHandler(
      makeRetryCtx({ headers: {}, body: { reason: 'retry now' } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(resetMock).not.toHaveBeenCalled();
  });

  it('400 when Idempotency-Key is shorter than min', async () => {
    const res = await adminRetryPayoutHandler(
      makeRetryCtx({ headers: { 'idempotency-key': 'short' }, body: { reason: 'ok' } }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when body is not valid JSON', async () => {
    const res = await adminRetryPayoutHandler(
      makeRetryCtx({ headers: { 'idempotency-key': validKey } }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when reason is empty', async () => {
    const res = await adminRetryPayoutHandler(
      makeRetryCtx({ headers: { 'idempotency-key': validKey }, body: { reason: '' } }),
    );
    expect(res.status).toBe(400);
  });

  it('401 when admin context is missing', async () => {
    const res = await adminRetryPayoutHandler(
      makeRetryCtx({
        headers: { 'idempotency-key': validKey },
        body: { reason: 'retry please' },
        user: null,
      }),
    );
    expect(res.status).toBe(401);
    expect(resetMock).not.toHaveBeenCalled();
  });

  it('happy path returns { result, audit } envelope + stores snapshot + fires Discord', async () => {
    const res = await adminRetryPayoutHandler(
      makeRetryCtx({
        headers: { 'idempotency-key': validKey },
        body: { reason: 'stuck since tuesday' },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { id: string; state: string; userId: string };
      audit: { actorUserId: string; idempotencyKey: string; replayed: boolean };
    };
    expect(body.result.id).toBe(payoutId);
    expect(body.result.state).toBe('pending');
    expect(body.audit.actorUserId).toBe(admin.id);
    expect(body.audit.idempotencyKey).toBe(validKey);
    expect(body.audit.replayed).toBe(false);
    expect(resetMock).toHaveBeenCalledWith(payoutId);
    expect(idempotencyState.storedSnapshot).not.toBeNull();
    expect(idempotencyState.discordCalls).toHaveLength(1);
    expect(idempotencyState.discordCalls[0]).toMatchObject({
      actorUserId: admin.id,
      reason: 'stuck since tuesday',
      replayed: false,
    });
  });

  it('404 when the row is not in failed state (not snapshot-stored)', async () => {
    resetMock.mockResolvedValue(null);
    const res = await adminRetryPayoutHandler(
      makeRetryCtx({
        headers: { 'idempotency-key': validKey },
        body: { reason: 'trying' },
      }),
    );
    expect(res.status).toBe(404);
    expect(idempotencyState.storedSnapshot).toBeNull();
    expect(idempotencyState.discordCalls).toHaveLength(0);
  });

  it('500 when the repo throws', async () => {
    resetMock.mockRejectedValue(new Error('db exploded'));
    const res = await adminRetryPayoutHandler(
      makeRetryCtx({
        headers: { 'idempotency-key': validKey },
        body: { reason: 'trying' },
      }),
    );
    expect(res.status).toBe(500);
  });

  it('replay path returns stored snapshot, fires Discord replayed, skips apply', async () => {
    idempotencyState.priorSnapshot = {
      status: 200,
      body: {
        result: { id: payoutId, userId: resetRow.userId, state: 'pending' },
        audit: {
          actorUserId: admin.id,
          actorEmail: admin.email,
          idempotencyKey: validKey,
          appliedAt: new Date().toISOString(),
          replayed: false,
        },
      },
      createdAt: new Date(),
    };
    const res = await adminRetryPayoutHandler(
      makeRetryCtx({
        headers: { 'idempotency-key': validKey },
        body: { reason: 'second click' },
      }),
    );
    expect(res.status).toBe(200);
    expect(resetMock).not.toHaveBeenCalled();
    expect(idempotencyState.discordCalls).toHaveLength(1);
    expect(idempotencyState.discordCalls[0]?.['replayed']).toBe(true);
  });
});
