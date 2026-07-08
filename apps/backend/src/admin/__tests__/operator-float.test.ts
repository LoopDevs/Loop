import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const { dbMock, state } = vi.hoisted(() => {
  const rows: unknown[] = [];
  const m: Record<string, ReturnType<typeof vi.fn>> = {};
  const tx: Record<string, ReturnType<typeof vi.fn>> = {};
  const txState = {
    insertTable: null as unknown,
    baselineRow: {
      id: '11111111-1111-4111-8111-111111111111',
      asset: 'xlm',
      account: 'GOPERATORACCOUNT',
      openingBalanceStroops: 123n,
      startingHorizonCursor: '123',
      active: 1,
      createdAt: new Date('2026-07-07T10:00:00Z'),
    },
    manualMovementRow: {
      id: '22222222-2222-4222-8222-222222222222',
      asset: 'usdc',
      account: 'GOPERATORACCOUNT',
      direction: 'out',
      amountStroops: 50n,
      movementPaymentId: 'pay-1',
      effectiveAt: new Date('2026-07-07T11:00:00Z'),
      createdAt: new Date('2026-07-07T11:01:00Z'),
    },
    updateCalls: [] as Array<Record<string, unknown>>,
    insertValues: [] as Array<Record<string, unknown>>,
    priorSnapshot: null as null | { status: number; body: Record<string, unknown> },
    storedSnapshot: null as null | Record<string, unknown>,
    discordCalls: [] as Array<Record<string, unknown>>,
    // Rows served to the linkage-validation `SELECT … FOR UPDATE` on
    // operator_wallet_movements (F7). Default: matches the canonical
    // 'pay-1' manual-movement request.
    linkedMovementRows: [] as unknown[],
  };
  m['select'] = vi.fn(() => m);
  m['from'] = vi.fn(() => m);
  m['where'] = vi.fn(() => m);
  m['orderBy'] = vi.fn(() => m);
  m['limit'] = vi.fn(async () => rows);
  tx['select'] = vi.fn(() => tx);
  tx['from'] = vi.fn(() => tx);
  tx['for'] = vi.fn(async () => txState.linkedMovementRows);
  tx['update'] = vi.fn(() => tx);
  tx['set'] = vi.fn((values: Record<string, unknown>) => {
    txState.updateCalls.push(values);
    return tx;
  });
  tx['where'] = vi.fn(() => tx);
  tx['insert'] = vi.fn((table: unknown) => {
    txState.insertTable = table;
    return tx;
  });
  tx['values'] = vi.fn((values: Record<string, unknown>) => {
    txState.insertValues.push(values);
    return tx;
  });
  tx['returning'] = vi.fn(async () => {
    if ((txState.insertTable as { __name?: string } | null)?.__name === 'operatorWalletBaselines') {
      return [txState.baselineRow];
    }
    return [txState.manualMovementRow];
  });
  m['transaction'] = vi.fn(async (fn: (txArg: typeof tx) => Promise<unknown>) => fn(tx));
  return { dbMock: m, state: { rows, tx, txState } };
});

vi.mock('../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../db/schema.js', () => ({
  OPERATOR_FLOAT_ASSETS: ['xlm', 'usdc'] as const,
  OPERATOR_FLOAT_CLASSIFICATIONS: [
    'user_deposit',
    'ctx_settlement',
    'deposit_refund',
    'manual',
    'unclassified',
  ],
  OPERATOR_FLOAT_DIRECTIONS: ['in', 'out'] as const,
  operatorManualMovements: 'operatorManualMovements',
  operatorWalletBaselines: {
    __name: 'operatorWalletBaselines',
    account: 'account',
    active: 'active',
    asset: 'asset',
  },
  operatorWalletMovements: {
    paymentId: 'paymentId',
    txHash: 'txHash',
    asset: 'asset',
    direction: 'direction',
    amountStroops: 'amountStroops',
    classification: 'classification',
    fromAddress: 'fromAddress',
    toAddress: 'toAddress',
    memoText: 'memoText',
    observedAt: 'observedAt',
  },
}));

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
      if (state.txState.priorSnapshot !== null) {
        return {
          replayed: true,
          status: state.txState.priorSnapshot.status,
          body: state.txState.priorSnapshot.body,
        };
      }
      const { status, body } = await doWrite();
      state.txState.storedSnapshot = { ...args, status, body };
      return { replayed: false, status, body };
    },
  ),
}));

vi.mock('../../discord.js', () => ({
  notifyAdminAudit: vi.fn((args: Record<string, unknown>) => {
    state.txState.discordCalls.push(args);
  }),
}));

import {
  adminOperatorFloatBaselineCreateHandler,
  adminOperatorFloatManualMovementCreateHandler,
  adminOperatorFloatMovementsHandler,
} from '../operator-float.js';

const actor = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'ops@loop.test',
  isAdmin: true,
  homeCurrency: 'GBP',
  stellarAddress: null,
  ctxUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const validKey = 'k'.repeat(32);

function ctx(query: Record<string, string | undefined> = {}): Context {
  return {
    req: {
      query: (key: string) => query[key],
    },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

function writeCtx(args: {
  headers?: Record<string, string>;
  body?: unknown;
  user?: typeof actor | null;
}): Context {
  const store = new Map<string, unknown>();
  if (args.user !== null) store.set('user', args.user ?? actor);
  return {
    req: {
      header: (key: string) => args.headers?.[key.toLowerCase()],
      json: async () => {
        if (args.body === undefined) throw new Error('no body');
        return args.body;
      },
    },
    get: (key: string) => store.get(key),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  state.rows.length = 0;
  for (const fn of Object.values(dbMock)) fn.mockClear();
  for (const fn of Object.values(state.tx)) fn.mockClear();
  state.txState.insertTable = null;
  state.txState.updateCalls = [];
  state.txState.insertValues = [];
  state.txState.priorSnapshot = null;
  state.txState.storedSnapshot = null;
  state.txState.discordCalls = [];
  state.txState.linkedMovementRows = [
    {
      asset: 'usdc',
      account: 'GOPERATORACCOUNT',
      direction: 'out',
      amountStroops: 50n,
      classification: 'unclassified',
    },
  ];
});

describe('adminOperatorFloatMovementsHandler', () => {
  it('defaults to unclassified movements and clamps response shape', async () => {
    state.rows.push({
      paymentId: 'op-1',
      txHash: 'tx-1',
      asset: 'xlm',
      direction: 'in',
      amountStroops: '10000000',
      classification: 'unclassified',
      fromAddress: 'GUSER',
      toAddress: 'GOPERATOR',
      memoText: 'memo-1',
      observedAt: '2026-07-07 12:00:00+00',
    });

    const res = await adminOperatorFloatMovementsHandler(ctx());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ movements: state.rows });
    expect(dbMock.limit).toHaveBeenCalledWith(50);
  });

  it('accepts known classifications and caps limit at 200', async () => {
    await adminOperatorFloatMovementsHandler(
      ctx({ classification: 'ctx_settlement', limit: '999' }),
    );

    expect(dbMock.limit).toHaveBeenCalledWith(200);
  });
});

describe('adminOperatorFloatBaselineCreateHandler', () => {
  it('400 when Idempotency-Key header is missing', async () => {
    const res = await adminOperatorFloatBaselineCreateHandler(
      writeCtx({
        body: {
          asset: 'xlm',
          account: 'GOPERATORACCOUNT',
          openingBalanceStroops: '123',
          reason: 'initial reconciliation baseline',
        },
      }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  });

  it('F8: 400 when startingHorizonCursor is missing — a baseline must anchor balance + cursor together', async () => {
    const res = await adminOperatorFloatBaselineCreateHandler(
      writeCtx({
        headers: { 'idempotency-key': validKey },
        body: {
          asset: 'xlm',
          account: 'GOPERATORACCOUNT',
          openingBalanceStroops: '123',
          reason: 'initial reconciliation baseline',
        },
      }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(state.txState.insertValues).toHaveLength(0);
  });

  it('creates an audited baseline envelope and stores an idempotency snapshot', async () => {
    const res = await adminOperatorFloatBaselineCreateHandler(
      writeCtx({
        headers: { 'idempotency-key': validKey },
        body: {
          asset: 'xlm',
          account: 'GOPERATORACCOUNT',
          openingBalanceStroops: '123',
          startingHorizonCursor: '123',
          reason: 'initial reconciliation baseline',
        },
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: Record<string, unknown>; audit: unknown };
    expect(body.result).toMatchObject({
      id: state.txState.baselineRow.id,
      account: 'GOPERATORACCOUNT',
      openingBalanceStroops: '123',
      startingHorizonCursor: '123',
      active: 1,
      createdAt: '2026-07-07T10:00:00.000Z',
    });
    expect(body.audit).toMatchObject({
      actorUserId: actor.id,
      actorEmail: actor.email,
      idempotencyKey: validKey,
      replayed: false,
    });
    expect(state.txState.insertValues[0]).toMatchObject({
      asset: 'xlm',
      account: 'GOPERATORACCOUNT',
      openingBalanceStroops: 123n,
      reason: 'initial reconciliation baseline',
      createdBy: actor.id,
    });
    expect(state.txState.storedSnapshot).toMatchObject({
      adminUserId: actor.id,
      key: validKey,
      method: 'POST',
      path: '/api/admin/operator-float/baselines',
    });
    expect(state.txState.discordCalls).toEqual([
      expect.objectContaining({
        actorUserId: actor.id,
        endpoint: 'POST /api/admin/operator-float/baselines',
        reason: 'initial reconciliation baseline',
        idempotencyKey: validKey,
        replayed: false,
      }),
    ]);
  });
});

describe('adminOperatorFloatManualMovementCreateHandler', () => {
  it('records a manual movement and links the indexed payment when supplied', async () => {
    const res = await adminOperatorFloatManualMovementCreateHandler(
      writeCtx({
        headers: { 'idempotency-key': validKey },
        body: {
          asset: 'usdc',
          account: 'GOPERATORACCOUNT',
          direction: 'out',
          amountStroops: '50',
          movementPaymentId: 'pay-1',
          effectiveAt: '2026-07-07T11:00:00.000Z',
          reason: 'operator sweep to rebalance float',
        },
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: Record<string, unknown>; audit: unknown };
    expect(body.result).toMatchObject({
      id: state.txState.manualMovementRow.id,
      asset: 'usdc',
      direction: 'out',
      amountStroops: '50',
      movementPaymentId: 'pay-1',
      effectiveAt: '2026-07-07T11:00:00.000Z',
      createdAt: '2026-07-07T11:01:00.000Z',
    });
    expect(state.txState.insertValues[0]).toMatchObject({
      asset: 'usdc',
      account: 'GOPERATORACCOUNT',
      direction: 'out',
      amountStroops: 50n,
      movementPaymentId: 'pay-1',
      reason: 'operator sweep to rebalance float',
      createdBy: actor.id,
    });
    expect(state.txState.updateCalls).toContainEqual(
      expect.objectContaining({
        classification: 'manual',
        manualMovementId: state.txState.manualMovementRow.id,
      }),
    );
    expect(state.txState.discordCalls).toEqual([
      expect.objectContaining({
        actorUserId: actor.id,
        endpoint: 'POST /api/admin/operator-float/manual-movements',
        reason: 'operator sweep to rebalance float',
        idempotencyKey: validKey,
        replayed: false,
      }),
    ]);
  });

  function manualMovementCtx(body?: Record<string, unknown>): Context {
    return writeCtx({
      headers: { 'idempotency-key': validKey },
      body: {
        asset: 'usdc',
        account: 'GOPERATORACCOUNT',
        direction: 'out',
        amountStroops: '50',
        movementPaymentId: 'pay-1',
        reason: 'operator sweep to rebalance float',
        ...body,
      },
    });
  }

  it('F7: 400 when the linked movement is not indexed — no manual row, no snapshot, no audit', async () => {
    state.txState.linkedMovementRows = [];
    const res = await adminOperatorFloatManualMovementCreateHandler(manualMovementCtx());
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(state.txState.insertValues).toHaveLength(0);
    // A rolled-back write must not leave a replay snapshot, so a
    // corrected retry with the same key runs fresh.
    expect(state.txState.storedSnapshot).toBeNull();
    expect(state.txState.discordCalls).toHaveLength(0);
  });

  it('F7: 400 when the linked movement is already classified — refuses to reclassify', async () => {
    state.txState.linkedMovementRows = [
      {
        asset: 'usdc',
        account: 'GOPERATORACCOUNT',
        direction: 'out',
        amountStroops: 50n,
        classification: 'ctx_settlement',
      },
    ];
    const res = await adminOperatorFloatManualMovementCreateHandler(manualMovementCtx());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain('already classified');
    expect(state.txState.insertValues).toHaveLength(0);
  });

  it('F7: 400 when the declared shape does not match the indexed movement', async () => {
    // Declared 50 stroops out; the real movement is 5_000_000 stroops.
    state.txState.linkedMovementRows = [
      {
        asset: 'usdc',
        account: 'GOPERATORACCOUNT',
        direction: 'out',
        amountStroops: 5_000_000n,
        classification: 'unclassified',
      },
    ];
    const res = await adminOperatorFloatManualMovementCreateHandler(manualMovementCtx());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain('do not match');
    expect(state.txState.insertValues).toHaveLength(0);
    expect(state.txState.updateCalls).toHaveLength(0);
  });
});
