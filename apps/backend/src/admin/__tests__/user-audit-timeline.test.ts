/**
 * Unit coverage for the A5-7 per-subject admin audit timeline
 * (`GET /api/admin/users/:userId/audit`, `../user-audit-timeline.ts`).
 * Mirrors the mock shape of `ledger.test.ts` / `user-credit-
 * transactions.test.ts`: `../../db/client.js` + `../../db/schema.js`
 * + `drizzle-orm` are mocked so the handler's own query-building logic
 * runs for real against canned per-table row fixtures.
 *
 * Covers: the merge + newest-first sort across five sources, that
 * EVERY source query reaches an explicit `.limit()` (never unbounded —
 * S4-6), 400s on malformed input, 404 on unknown user, never-500 on
 * odd-but-valid input, and — the CF-10-relevant assertion — that a
 * maximally-populated DEFAULT response stays under the global
 * bulk-read threshold.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import { BULK_LIST_ROW_THRESHOLD, countAdminListRows } from '../read-audit.js';

// Single canonical set of table markers, shared by reference between
// the `../../db/schema.js` mock's exports and `fromMock`'s switch
// below — `vi.mock('../../db/schema.js', ...)` factories run in
// isolation, so spreading a copy of these into a NEW object per
// export would break the identity comparison `.from(table)` relies
// on to route to the right canned rows.
const TABLES = vi.hoisted(() => ({
  adminIdempotencyKeys: {
    adminUserId: 'admin_idempotency_keys.admin_user_id',
    path: 'admin_idempotency_keys.path',
    method: 'admin_idempotency_keys.method',
    status: 'admin_idempotency_keys.status',
    createdAt: 'admin_idempotency_keys.created_at',
  },
  creditTransactions: {
    userId: 'credit_transactions.user_id',
    createdAt: 'credit_transactions.created_at',
  },
  orders: {
    id: 'orders.id',
    userId: 'orders.user_id',
    createdAt: 'orders.created_at',
  },
  otpAttemptCounters: {
    email: 'otp_attempt_counters.email',
    lockedUntil: 'otp_attempt_counters.locked_until',
  },
  refreshTokens: {
    userId: 'refresh_tokens.user_id',
    revokedAt: 'refresh_tokens.revoked_at',
    replacedByJti: 'refresh_tokens.replaced_by_jti',
  },
  users: {
    id: 'users.id',
    email: 'users.email',
  },
}));

const state = vi.hoisted(() => ({
  subjectRows: [] as Array<Record<string, unknown>>,
  adminActionRows: [] as Array<Record<string, unknown>>,
  ledgerRows: [] as Array<Record<string, unknown>>,
  orderRows: [] as Array<Record<string, unknown>>,
  payoutRows: [] as Array<Record<string, unknown>>,
  sessionRows: [] as Array<Record<string, unknown>>,
  lockRows: [] as Array<Record<string, unknown>>,
  throwErr: null as Error | null,
  limitCalls: [] as Array<{ table: string; n: number }>,
  whereCalls: [] as Array<{ table: string; cond: unknown }>,
}));

vi.mock('../../credits/pending-payouts.js', () => ({
  listPayoutsForAdmin: vi.fn(async (opts: { limit?: number }) => {
    state.limitCalls.push({ table: 'pending_payouts', n: opts.limit ?? -1 });
    return state.payoutRows;
  }),
}));

vi.mock('../../db/schema.js', () => ({
  adminIdempotencyKeys: TABLES.adminIdempotencyKeys,
  creditTransactions: TABLES.creditTransactions,
  orders: TABLES.orders,
  otpAttemptCounters: TABLES.otpAttemptCounters,
  refreshTokens: TABLES.refreshTokens,
  users: TABLES.users,
}));

vi.mock('drizzle-orm', async () => {
  const actual = (await vi.importActual('drizzle-orm')) as Record<string, unknown>;
  return {
    ...actual,
    eq: (col: unknown, value: unknown) => ({ __eq: true, col, value }),
    and: (...conds: unknown[]) => ({ __and: true, conds }),
    or: (...conds: unknown[]) => ({ __or: true, conds }),
    like: (col: unknown, value: unknown) => ({ __like: true, col, value }),
    desc: (col: unknown) => ({ __desc: true, col }),
    lt: (col: unknown, value: unknown) => ({ __lt: true, col, value }),
    isNotNull: (col: unknown) => ({ __isNotNull: true, col }),
    isNull: (col: unknown) => ({ __isNull: true, col }),
  };
});

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

function makeChainFor(tableName: string, rows: Array<Record<string, unknown>>): unknown {
  const chain: Record<string, unknown> = {};
  const self = (): unknown => chain;
  chain.where = (cond: unknown) => {
    state.whereCalls.push({ table: tableName, cond });
    return chain;
  };
  chain.orderBy = self;
  chain.innerJoin = self;
  chain.limit = async (n: number) => {
    if (state.throwErr !== null) throw state.throwErr;
    state.limitCalls.push({ table: tableName, n });
    return rows.slice(0, n);
  };
  return chain;
}

function fromMock(table: unknown): unknown {
  switch (table) {
    case TABLES.adminIdempotencyKeys:
      return makeChainFor('admin_idempotency_keys', state.adminActionRows);
    case TABLES.creditTransactions:
      return makeChainFor('credit_transactions', state.ledgerRows);
    case TABLES.orders:
      return makeChainFor('orders', state.orderRows);
    case TABLES.refreshTokens:
      return makeChainFor('refresh_tokens', state.sessionRows);
    case TABLES.otpAttemptCounters:
      return makeChainFor('otp_attempt_counters', state.lockRows);
    case TABLES.users:
      return makeChainFor('users', state.subjectRows);
    default:
      return makeChainFor('unknown', []);
  }
}

vi.mock('../../db/client.js', () => ({
  db: { select: () => ({ from: fromMock }) },
}));

import { adminUserAuditTimelineHandler } from '../user-audit-timeline.js';

function makeCtx(params: Record<string, string>, query: Record<string, string> = {}): Context {
  return {
    req: {
      param: (k: string) => params[k],
      query: (k: string) => query[k],
    },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

const USER_ID = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  state.subjectRows = [{ id: USER_ID, email: 'alice@loop.test' }];
  state.adminActionRows = [];
  state.ledgerRows = [];
  state.orderRows = [];
  state.sessionRows = [];
  state.lockRows = [];
  state.payoutRows = [];
  state.throwErr = null;
  state.limitCalls = [];
  state.whereCalls = [];
});

describe('adminUserAuditTimelineHandler', () => {
  it('400 when userId is not a uuid', async () => {
    const res = await adminUserAuditTimelineHandler(makeCtx({ userId: 'nope' }));
    expect(res.status).toBe(400);
  });

  it('404 when the user does not exist', async () => {
    state.subjectRows = [];
    const res = await adminUserAuditTimelineHandler(makeCtx({ userId: USER_ID }));
    expect(res.status).toBe(404);
  });

  it('400 on malformed before', async () => {
    const res = await adminUserAuditTimelineHandler(
      makeCtx({ userId: USER_ID }, { before: 'not-a-date' }),
    );
    expect(res.status).toBe(400);
  });

  it('never-500 on an odd-but-well-formed request (all sources empty)', async () => {
    const res = await adminUserAuditTimelineHandler(makeCtx({ userId: USER_ID }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; events: unknown[] };
    expect(body).toEqual({ userId: USER_ID, events: [] });
  });

  it('500 when a query throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminUserAuditTimelineHandler(makeCtx({ userId: USER_ID }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INTERNAL_ERROR');
  });

  it('merges every source and sorts newest-first', async () => {
    state.adminActionRows = [
      {
        actorEmail: 'admin@loop.test',
        method: 'POST',
        path: `/api/admin/users/${USER_ID}/credit-adjustments`,
        status: 200,
        createdAt: new Date('2026-07-05T12:00:00Z'),
      },
    ];
    state.ledgerRows = [
      {
        id: 'tx-1',
        userId: USER_ID,
        type: 'cashback',
        amountMinor: 500n,
        currency: 'USD',
        referenceType: 'order',
        referenceId: 'order-1',
        createdAt: new Date('2026-07-04T12:00:00Z'),
      },
    ];
    state.orderRows = [
      {
        id: 'order-1',
        state: 'fulfilled',
        currency: 'USD',
        chargeCurrency: 'USD',
        chargeMinor: 1000n,
        merchantId: 'merchant-1',
        failureReason: null,
        createdAt: new Date('2026-07-03T12:00:00Z'),
        paidAt: new Date('2026-07-03T12:01:00Z'),
        procuredAt: new Date('2026-07-03T12:02:00Z'),
        // Deliberately AFTER the admin action's createdAt (07-05) — if
        // the merged `at` used this instead of `createdAt`, the order
        // would incorrectly sort first. See the "merged `at` is
        // createdAt, not the latest milestone" test below.
        fulfilledAt: new Date('2026-07-06T00:00:00Z'),
        failedAt: null,
      },
    ];
    state.payoutRows = [
      {
        id: 'payout-1',
        userId: USER_ID,
        orderId: 'order-1',
        kind: 'order_cashback',
        assetCode: 'USDLOOP',
        assetIssuer: 'GISSUER',
        toAddress: 'GADDR',
        amountStroops: 5000000n,
        memoText: 'memo',
        state: 'confirmed',
        txHash: 'deadbeef',
        lastError: null,
        attempts: 1,
        createdAt: new Date('2026-07-02T12:00:00Z'),
        submittedAt: new Date('2026-07-02T12:01:00Z'),
        confirmedAt: new Date('2026-07-02T12:02:00Z'),
        failedAt: null,
      },
    ];
    state.sessionRows = [
      {
        jti: 'jti-1',
        createdAt: new Date('2026-07-01T00:00:00Z'),
        revokedAt: new Date('2026-07-01T12:00:00Z'),
      },
    ];

    const res = await adminUserAuditTimelineHandler(makeCtx({ userId: USER_ID }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      userId: string;
      events: Array<{ kind: string; at: string; refType: string | null; refId: string | null }>;
    };
    expect(body.userId).toBe(USER_ID);
    expect(body.events).toHaveLength(5);
    // Newest first, by createdAt (admin_action 07-05 > ledger 07-04 >
    // order 07-03 > payout 07-02 > session 07-01). The order event's
    // `at` is its `createdAt` (07-03), NOT its later `fulfilledAt`
    // (07-06) — money-review fix: `at` must equal the column the
    // `before` cursor filters on, or a row can re-appear on the next
    // "older" page (see the dedicated cursor-consistency test below).
    expect(body.events.map((e) => e.kind)).toEqual([
      'admin_action',
      'ledger',
      'order',
      'payout',
      'session_revoked',
    ]);
    const orderEvent = body.events.find((e) => e.kind === 'order');
    expect(orderEvent).toMatchObject({
      at: '2026-07-03T12:00:00.000Z',
      refType: 'order',
      refId: 'order-1',
    });
    const ledgerEvent = body.events.find((e) => e.kind === 'ledger');
    expect(ledgerEvent).toMatchObject({ refType: 'order', refId: 'order-1' }); // ledger row references the order
  });

  // Money-review finding: the merged `at` for orders/payouts must be
  // the SAME column the `before` cursor's WHERE clause filters on
  // (`createdAt`), not a later milestone — otherwise a milestone-heavy
  // row (created long ago, fulfilled recently) could pass the
  // cursor's `createdAt < before` check yet still recompute to the
  // same `at` on the next page, reappearing forever and stalling
  // "Older" paging just below it. This mock doesn't execute real SQL
  // filtering (see `makeChainFor` — same limitation as
  // `ledger.test.ts`'s mock), so the proof is structural: assert the
  // `before` condition captured for the `orders` query is built from
  // `orders.createdAt` — the exact column the emitted `at` uses.
  it('cursor consistency: the orders `before` filter uses the same column as `at` (createdAt)', async () => {
    state.orderRows = [
      {
        id: 'order-old-milestone',
        state: 'fulfilled',
        currency: 'USD',
        chargeCurrency: 'USD',
        chargeMinor: 1000n,
        merchantId: 'merchant-1',
        failureReason: null,
        createdAt: new Date('2026-01-01T00:00:00Z'), // created long ago
        paidAt: new Date('2026-01-01T00:01:00Z'),
        procuredAt: new Date('2026-01-01T00:02:00Z'),
        fulfilledAt: new Date('2026-07-05T00:00:00Z'), // fulfilled recently
        failedAt: null,
      },
    ];

    const beforeCursor = new Date('2026-07-06T00:00:00Z');
    const res = await adminUserAuditTimelineHandler(
      makeCtx({ userId: USER_ID }, { before: beforeCursor.toISOString() }),
    );
    const body = (await res.json()) as { events: Array<{ at: string; kind: string }> };
    expect(body.events).toHaveLength(1);
    // `at` is createdAt, not the later fulfilledAt.
    expect(body.events[0]?.at).toBe('2026-01-01T00:00:00.000Z');

    const orderWhere = state.whereCalls.find((c) => c.table === 'orders')?.cond as
      | { conds: unknown[] }
      | undefined;
    expect(orderWhere).toBeDefined();
    const ltCond = orderWhere?.conds.find(
      (c): c is { __lt: true; col: unknown; value: Date } =>
        typeof c === 'object' && c !== null && '__lt' in c,
    );
    expect(ltCond?.col).toBe(TABLES.orders.createdAt); // orders.created_at, not fulfilledAt
    expect(ltCond?.value).toEqual(beforeCursor);
  });

  it('every source query is bounded by an explicit .limit() call (S4-6)', async () => {
    await adminUserAuditTimelineHandler(makeCtx({ userId: USER_ID }, { limit: '5' }));
    const tables = state.limitCalls.map((c) => c.table).sort();
    expect(tables).toEqual(
      [
        'admin_idempotency_keys',
        'credit_transactions',
        'orders',
        'otp_attempt_counters',
        'pending_payouts',
        'refresh_tokens',
        'users', // the up-front subject-existence lookup
      ].sort(),
    );
    for (const c of state.limitCalls) {
      if (c.table === 'otp_attempt_counters' || c.table === 'users') {
        expect(c.n).toBe(1); // single-row PK lookups, not the per-source limit
      } else {
        expect(c.n).toBe(5);
      }
    }
  });

  it('limit clamps to [1, 20] with a default of 8', async () => {
    await adminUserAuditTimelineHandler(makeCtx({ userId: USER_ID }));
    expect(state.limitCalls.find((c) => c.table === 'orders')?.n).toBe(8);

    state.limitCalls = [];
    await adminUserAuditTimelineHandler(makeCtx({ userId: USER_ID }, { limit: '999' }));
    expect(state.limitCalls.find((c) => c.table === 'orders')?.n).toBe(20);

    state.limitCalls = [];
    await adminUserAuditTimelineHandler(makeCtx({ userId: USER_ID }, { limit: '0' }));
    expect(state.limitCalls.find((c) => c.table === 'orders')?.n).toBe(1);
  });

  // CF-10: a maximally-populated DEFAULT response (every list source
  // returns exactly DEFAULT_PER_SOURCE_LIMIT rows, plus the OTP-lock
  // snapshot) must stay under the global bulk-read threshold so a
  // routine support-triage page load doesn't trip the tripwire.
  it('a maximally-populated default response stays under the CF-10 bulk-read threshold', async () => {
    const DEFAULT = 8;
    state.adminActionRows = Array.from({ length: DEFAULT }, (_, i) => ({
      actorEmail: 'admin@loop.test',
      method: 'POST',
      path: `/api/admin/users/${USER_ID}/credit-adjustments`,
      status: 200,
      createdAt: new Date(Date.now() - i * 1000),
    }));
    state.ledgerRows = Array.from({ length: DEFAULT }, (_, i) => ({
      id: `tx-${i}`,
      userId: USER_ID,
      type: 'cashback',
      amountMinor: 100n,
      currency: 'USD',
      referenceType: null,
      referenceId: null,
      createdAt: new Date(Date.now() - i * 1000),
    }));
    state.orderRows = Array.from({ length: DEFAULT }, (_, i) => ({
      id: `order-${i}`,
      state: 'fulfilled',
      currency: 'USD',
      chargeCurrency: 'USD',
      chargeMinor: 100n,
      merchantId: 'merchant-1',
      failureReason: null,
      createdAt: new Date(Date.now() - i * 1000),
      paidAt: null,
      procuredAt: null,
      fulfilledAt: null,
      failedAt: null,
    }));
    state.payoutRows = Array.from({ length: DEFAULT }, (_, i) => ({
      id: `payout-${i}`,
      userId: USER_ID,
      orderId: null,
      kind: 'emission',
      assetCode: 'USDLOOP',
      assetIssuer: 'GISSUER',
      toAddress: 'GADDR',
      amountStroops: 100n,
      memoText: 'memo',
      state: 'confirmed',
      txHash: null,
      lastError: null,
      attempts: 0,
      createdAt: new Date(Date.now() - i * 1000),
      submittedAt: null,
      confirmedAt: null,
      failedAt: null,
    }));
    state.sessionRows = Array.from({ length: DEFAULT }, (_, i) => ({
      jti: `jti-${i}`,
      createdAt: new Date(Date.now() - i * 1000),
      revokedAt: new Date(Date.now() - i * 1000),
    }));
    state.lockRows = [
      {
        lockedUntil: new Date(Date.now() + 60_000),
        failedAttempts: 5,
        updatedAt: new Date(),
      },
    ];

    const res = await adminUserAuditTimelineHandler(makeCtx({ userId: USER_ID }));
    expect(res.status).toBe(200);
    const bodyText = await res.text();
    const body = JSON.parse(bodyText) as { events: unknown[] };
    expect(body.events).toHaveLength(DEFAULT * 5 + 1); // 5 list sources + 1 lock snapshot
    const rowCount = countAdminListRows(bodyText, 'application/json; charset=utf-8');
    expect(rowCount).toBe(body.events.length);
    expect(rowCount).toBeLessThan(BULK_LIST_ROW_THRESHOLD);
  });
});
