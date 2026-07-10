/**
 * Unit coverage for the A5-8 fleet-wide admin ledger browser
 * (`GET /api/admin/ledger`, `../ledger.ts`). Mirrors the mock shape
 * of `user-credit-transactions.test.ts` (the per-user sibling this
 * endpoint generalises), plus assertions specific to this endpoint's
 * job: multiple independent filters, the fleet-wide (no userId)
 * case, and — the money-review-relevant bit — that the query is
 * ALWAYS bounded by an explicit, clamped `.limit()` call, never an
 * unbounded scan (S4-6).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  throwErr: null as Error | null,
}));

const limitMock = vi.fn(async (_n: number) => {
  if (state.throwErr !== null) throw state.throwErr;
  return state.rows;
});
const orderByMock = vi.fn(() => ({ limit: limitMock }));
const whereMock = vi.fn((_cond: unknown) => ({ orderBy: orderByMock }));
// `from()` must itself expose both `.where` (filtered path) and
// `.orderBy` (the unfiltered fleet-wide path skips `.where()`
// entirely — see admin/ledger.ts) so both branches resolve through
// the same mock chain.
const fromMock = vi.fn(() => ({ where: whereMock, orderBy: orderByMock }));
const selectMock = vi.fn(() => ({ from: fromMock }));

vi.mock('../../db/client.js', () => ({
  db: { select: () => selectMock() },
}));

vi.mock('../../db/schema.js', () => ({
  creditTransactions: {
    id: 'credit_transactions.id',
    userId: 'credit_transactions.user_id',
    type: 'credit_transactions.type',
    amountMinor: 'credit_transactions.amount_minor',
    currency: 'credit_transactions.currency',
    referenceType: 'credit_transactions.reference_type',
    referenceId: 'credit_transactions.reference_id',
    createdAt: 'credit_transactions.created_at',
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = (await vi.importActual('drizzle-orm')) as Record<string, unknown>;
  return {
    ...actual,
    eq: (col: unknown, value: unknown) => ({ __eq: true, col, value }),
    and: (...conds: unknown[]) => ({ __and: true, conds }),
    desc: (col: unknown) => ({ __desc: true, col }),
    gte: (col: unknown, value: unknown) => ({ __gte: true, col, value }),
    lt: (col: unknown, value: unknown) => ({ __lt: true, col, value }),
  };
});

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminLedgerHandler } from '../ledger.js';

function makeCtx(query: Record<string, string> = {}): Context {
  return {
    req: {
      query: (k: string) => query[k],
    },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

const userA = '11111111-2222-3333-4444-555555555555';
const userB = '66666666-7777-8888-9999-000000000000';

const rowA = {
  id: 'ctx-1111-2222-3333-4444-555555555555',
  userId: userA,
  type: 'cashback',
  amountMinor: 4200n,
  currency: 'GBP',
  referenceType: 'order',
  referenceId: 'o-1',
  createdAt: new Date('2026-04-21T12:00:00Z'),
};

const rowB = {
  id: 'ctx-9999-8888-7777-6666-555555555555',
  userId: userB,
  type: 'withdrawal',
  amountMinor: -1500n,
  currency: 'USD',
  referenceType: null,
  referenceId: null,
  createdAt: new Date('2026-04-20T09:00:00Z'),
};

beforeEach(() => {
  state.rows = [rowA, rowB];
  state.throwErr = null;
  limitMock.mockClear();
  orderByMock.mockClear();
  whereMock.mockClear();
  fromMock.mockClear();
  selectMock.mockClear();
});

describe('adminLedgerHandler', () => {
  it('200 with no filters — fleet-wide, newest first, userId echoed per row', async () => {
    const res = await adminLedgerHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { transactions: Array<Record<string, unknown>> };
    expect(body.transactions).toHaveLength(2);
    expect(body.transactions[0]).toMatchObject({
      id: rowA.id,
      userId: userA,
      type: 'cashback',
      amountMinor: '4200',
      currency: 'GBP',
      referenceType: 'order',
      referenceId: 'o-1',
      createdAt: '2026-04-21T12:00:00.000Z',
    });
    expect(body.transactions[1]).toMatchObject({
      userId: userB,
      type: 'withdrawal',
      amountMinor: '-1500',
      referenceType: null,
      referenceId: null,
    });
    // Unfiltered path: no `.where()` call, straight to `.orderBy().limit()` —
    // still bounded, just riding the plain created_at index instead of a
    // filtered composite one.
    expect(whereMock).not.toHaveBeenCalled();
    expect(orderByMock).toHaveBeenCalledTimes(1);
    expect(limitMock).toHaveBeenCalledTimes(1);
  });

  it('400 when userId is not a uuid', async () => {
    const res = await adminLedgerHandler(makeCtx({ userId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('400 when type is outside the enum', async () => {
    const res = await adminLedgerHandler(makeCtx({ type: 'rogue' }));
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('400 when referenceType has bad shape (uppercase / too long / empty)', async () => {
    expect((await adminLedgerHandler(makeCtx({ referenceType: 'Order' }))).status).toBe(400);
    expect((await adminLedgerHandler(makeCtx({ referenceType: 'a'.repeat(65) }))).status).toBe(400);
    expect((await adminLedgerHandler(makeCtx({ referenceType: '' }))).status).toBe(400);
  });

  it('400 when referenceId is empty or too long', async () => {
    expect((await adminLedgerHandler(makeCtx({ referenceId: '' }))).status).toBe(400);
    expect((await adminLedgerHandler(makeCtx({ referenceId: 'x'.repeat(129) }))).status).toBe(400);
  });

  it('400 on malformed since / before', async () => {
    expect((await adminLedgerHandler(makeCtx({ since: 'nope' }))).status).toBe(400);
    expect((await adminLedgerHandler(makeCtx({ before: 'nope' }))).status).toBe(400);
  });

  // Money-review finding on PR #1620: referenceType alone is a broad
  // equality prefix on the (reference_type, reference_id) index with
  // no created_at tail (most of the table has referenceType='order');
  // referenceId alone isn't even that index's leading column. Either
  // one supplied without the other must 400 rather than silently
  // running an unbounded-shaped query.
  it('400 when referenceType is supplied without referenceId (well-formed but unpaired)', async () => {
    const res = await adminLedgerHandler(makeCtx({ referenceType: 'order' }));
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('400 when referenceId is supplied without referenceType (well-formed but unpaired)', async () => {
    const res = await adminLedgerHandler(makeCtx({ referenceId: 'o-1' }));
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('accepts userId + type + referenceType + referenceId + since + before together', async () => {
    const res = await adminLedgerHandler(
      makeCtx({
        userId: userA,
        type: 'cashback',
        referenceType: 'order',
        referenceId: 'o-1',
        since: '2026-01-01T00:00:00.000Z',
        before: '2026-05-01T00:00:00.000Z',
      }),
    );
    expect(res.status).toBe(200);
    expect(whereMock).toHaveBeenCalledTimes(1);
    // Six independent conditions AND-ed together.
    const call = whereMock.mock.calls[0]?.[0] as { conds: unknown[] } | undefined;
    expect(call?.conds).toHaveLength(6);
  });

  it('bounded: limit clamps to [1, 200] with a default of 50 — never unbounded (S4-6)', async () => {
    await adminLedgerHandler(makeCtx());
    expect(limitMock).toHaveBeenLastCalledWith(50);

    await adminLedgerHandler(makeCtx({ limit: '5000' }));
    expect(limitMock).toHaveBeenLastCalledWith(200);

    await adminLedgerHandler(makeCtx({ limit: '0' }));
    expect(limitMock).toHaveBeenLastCalledWith(1);

    await adminLedgerHandler(makeCtx({ limit: 'not-a-number' }));
    expect(limitMock).toHaveBeenLastCalledWith(50);

    // Every call in this test reached `.limit(...)` — confirms the
    // handler can never return a query with no LIMIT clause.
    expect(limitMock).toHaveBeenCalledTimes(4);
  });

  it('never-500 on odd-but-well-formed filter input (empty result set)', async () => {
    state.rows = [];
    const res = await adminLedgerHandler(
      makeCtx({ userId: userA, type: 'refund', referenceType: 'payout', referenceId: 'p-404' }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { transactions: unknown[] }).toEqual({ transactions: [] });
  });

  it('500 when the query throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminLedgerHandler(makeCtx());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INTERNAL_ERROR');
  });
});
