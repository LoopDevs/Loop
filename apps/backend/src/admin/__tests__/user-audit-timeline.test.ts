/**
 * Unit coverage for the A5-7 per-subject admin audit timeline
 * (`GET /api/admin/users/:userId/audit`, `../user-audit-timeline.ts`).
 * Mirrors the mock shape of `ledger.test.ts` / `user-credit-
 * transactions.test.ts`: `../../db/client.js` + `../../db/schema.js`
 * + `drizzle-orm` are mocked so the handler's own query-building logic
 * runs for real against canned per-table row fixtures.
 *
 * Unlike the sibling mocks, this one is COMPOUND-KEYSET-AWARE: the
 * chain's `.limit()` honours the captured
 * `ts < at OR (ts = at AND id < id)` predicate (filters + sorts by
 * `(tsCol DESC, idCol DESC)` + slices), so a real multi-page keyset
 * walk — including one across a TIE boundary where many rows share a
 * timestamp — can be driven end-to-end. That's what lets the
 * completeness + tie tests below actually exercise (and prove) the
 * per-source compound-cursor fix.
 *
 * Covers: the merge + newest-first sort across five sources; that
 * EVERY source query reaches an explicit `.limit()` (never unbounded —
 * S4-6); the merged `at` == the cursor column (within-source
 * consistency); the CROSS-source completeness walk (no row lost under
 * uneven density); the TIE-boundary walk (no row lost when > limit
 * rows share one timestamp — the residual P1); 400s / 404 / never-500;
 * and the CF-10 default-response-size bound.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import { encodeAuditCursor, type AdminAuditTimelineCursors } from '@loop/shared';
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
    key: 'admin_idempotency_keys.key',
    method: 'admin_idempotency_keys.method',
    status: 'admin_idempotency_keys.status',
    path: 'admin_idempotency_keys.path',
    createdAt: 'admin_idempotency_keys.created_at',
  },
  creditTransactions: {
    id: 'credit_transactions.id',
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
    jti: 'refresh_tokens.jti',
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

// Faithfully compound-paginate the payouts source (the one that goes
// through `listPayoutsForAdmin`, not the drizzle chain): filter by the
// compound `(createdAt, id)` cursor, sort by (createdAt DESC, id DESC),
// slice `limit`.
vi.mock('../../credits/pending-payouts.js', () => ({
  listPayoutsForAdmin: vi.fn(
    async (opts: { limit?: number; before?: Date; beforeId?: string; tiebreakById?: boolean }) => {
      state.limitCalls.push({ table: 'pending_payouts', n: opts.limit ?? -1 });
      let rows = state.payoutRows;
      if (opts.before !== undefined) {
        const curTs = opts.before.getTime();
        const curId = opts.beforeId;
        rows = rows.filter((r) => {
          const ts = new Date(r.createdAt as string | Date).getTime();
          if (ts < curTs) return true;
          if (opts.tiebreakById && curId !== undefined && ts === curTs) {
            return String(r.id) < curId;
          }
          return false;
        });
      }
      rows = [...rows].sort((a, b) => cmpDesc(a, b, 'createdAt', 'id'));
      return rows.slice(0, opts.limit ?? rows.length);
    },
  ),
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

/** newest-first compare: tsField DESC, then idField DESC (string). */
function cmpDesc(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  tsField: string,
  idField: string,
): number {
  const d =
    new Date(b[tsField] as string | Date).getTime() -
    new Date(a[tsField] as string | Date).getTime();
  if (d !== 0) return d;
  const ai = String(a[idField]);
  const bi = String(b[idField]);
  return ai < bi ? 1 : ai > bi ? -1 : 0;
}

/** Pull the compound `{ ts, id }` cursor out of a captured where cond. */
function extractCompoundCursor(where: unknown): { ts: Date; id: string } | undefined {
  if (where === null || typeof where !== 'object') return undefined;
  const w = where as { __and?: boolean; conds?: unknown[] };
  const conds = w.__and ? (w.conds ?? []) : [where];
  const orNode = conds.find(
    (c): c is { __or: true; conds: unknown[] } =>
      typeof c === 'object' && c !== null && '__or' in c,
  );
  if (orNode === undefined) return undefined;
  const ltTs = orNode.conds.find(
    (c): c is { __lt: true; value: unknown } => typeof c === 'object' && c !== null && '__lt' in c,
  );
  const andNode = orNode.conds.find(
    (c): c is { __and: true; conds: unknown[] } =>
      typeof c === 'object' && c !== null && '__and' in c,
  );
  const ltId = andNode?.conds.find(
    (c): c is { __lt: true; value: unknown } => typeof c === 'object' && c !== null && '__lt' in c,
  );
  if (ltTs === undefined || ltId === undefined) return undefined;
  return { ts: new Date(ltTs.value as string | number | Date), id: String(ltId.value) };
}

/**
 * Compound-keyset-aware chain. When `tsField`/`idField` are set,
 * `.limit(n)` filters rows by the captured compound cursor
 * (`ts < at OR (ts = at AND id < id)`), sorts them by
 * `(tsField DESC, idField DESC)`, then slices — a real compound keyset
 * table. When undefined (single-row lookups: users / otp) it just
 * slices.
 */
function makeChainFor(
  tableName: string,
  rows: Array<Record<string, unknown>>,
  tsField?: string,
  idField?: string,
): unknown {
  const chain: Record<string, unknown> = {};
  let where: unknown;
  const self = (): unknown => chain;
  chain.where = (cond: unknown) => {
    where = cond;
    state.whereCalls.push({ table: tableName, cond });
    return chain;
  };
  chain.orderBy = self;
  chain.innerJoin = self;
  chain.limit = async (n: number) => {
    if (state.throwErr !== null) throw state.throwErr;
    state.limitCalls.push({ table: tableName, n });
    if (tsField === undefined || idField === undefined) return rows.slice(0, n);
    let out = rows;
    const cur = extractCompoundCursor(where);
    if (cur !== undefined) {
      const curTs = cur.ts.getTime();
      out = out.filter((r) => {
        const ts = new Date(r[tsField] as string | Date).getTime();
        if (ts < curTs) return true;
        if (ts === curTs) return String(r[idField]) < cur.id;
        return false;
      });
    }
    out = [...out].sort((a, b) => cmpDesc(a, b, tsField, idField));
    return out.slice(0, n);
  };
  return chain;
}

function fromMock(table: unknown): unknown {
  switch (table) {
    case TABLES.adminIdempotencyKeys:
      // tiebreaker column is `key`, surfaced on fixture rows as `cursorId`.
      return makeChainFor('admin_idempotency_keys', state.adminActionRows, 'createdAt', 'cursorId');
    case TABLES.creditTransactions:
      return makeChainFor('credit_transactions', state.ledgerRows, 'createdAt', 'id');
    case TABLES.orders:
      return makeChainFor('orders', state.orderRows, 'createdAt', 'id');
    case TABLES.refreshTokens:
      return makeChainFor('refresh_tokens', state.sessionRows, 'revokedAt', 'jti');
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

const NULL_CURSORS = {
  adminActions: null,
  ledger: null,
  orders: null,
  payouts: null,
  sessions: null,
};

/** Turn a `nextCursors` object into the request's compact `before*` params. */
function cursorsToQuery(c: AdminAuditTimelineCursors): Record<string, string> {
  const q: Record<string, string> = {};
  if (c.adminActions !== null) q.beforeAdminActions = encodeAuditCursor(c.adminActions);
  if (c.ledger !== null) q.beforeLedger = encodeAuditCursor(c.ledger);
  if (c.orders !== null) q.beforeOrders = encodeAuditCursor(c.orders);
  if (c.payouts !== null) q.beforePayouts = encodeAuditCursor(c.payouts);
  if (c.sessions !== null) q.beforeSessions = encodeAuditCursor(c.sessions);
  return q;
}

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

  it('400 on a malformed per-source cursor (no "|id" half)', async () => {
    const res = await adminUserAuditTimelineHandler(
      makeCtx({ userId: USER_ID }, { beforeLedger: 'not-a-date' }),
    );
    expect(res.status).toBe(400);
  });

  it('400 on a cursor with a non-ISO timestamp half', async () => {
    const res = await adminUserAuditTimelineHandler(
      makeCtx({ userId: USER_ID }, { beforeLedger: 'not-a-date|tx-1' }),
    );
    expect(res.status).toBe(400);
  });

  it('never-500 on an odd-but-well-formed request (all sources empty)', async () => {
    const res = await adminUserAuditTimelineHandler(makeCtx({ userId: USER_ID }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; events: unknown[]; nextCursors: unknown };
    expect(body).toEqual({ userId: USER_ID, events: [], nextCursors: NULL_CURSORS });
  });

  it('500 when a query throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminUserAuditTimelineHandler(makeCtx({ userId: USER_ID }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INTERNAL_ERROR');
  });

  it('merges every source and sorts newest-first (no cursorId leaks to the wire)', async () => {
    state.adminActionRows = [
      {
        cursorId: 'idem-1',
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
        // would incorrectly sort first (see the cursor-consistency test).
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
      events: Array<Record<string, unknown>>;
      nextCursors: AdminAuditTimelineCursors;
    };
    expect(body.userId).toBe(USER_ID);
    expect(body.events).toHaveLength(5);
    expect(body.events.map((e) => e.kind)).toEqual([
      'admin_action',
      'ledger',
      'order',
      'payout',
      'session_revoked',
    ]);
    // The internal cursorId tiebreaker must never leave the process.
    for (const e of body.events) expect(e).not.toHaveProperty('cursorId');
    const orderEvent = body.events.find((e) => e.kind === 'order');
    expect(orderEvent).toMatchObject({
      at: '2026-07-03T12:00:00.000Z',
      refType: 'order',
      refId: 'order-1',
    });
    // One row per source (< limit 8) → every source exhausted → all null.
    expect(body.nextCursors).toEqual(NULL_CURSORS);
  });

  // Money-review finding (within-source): the merged `at` for
  // orders/payouts must be `createdAt` (the cursor column), not a later
  // milestone.
  it('cursor consistency: orders page on (createdAt, id), and `at` is createdAt', async () => {
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

    const res = await adminUserAuditTimelineHandler(
      makeCtx(
        { userId: USER_ID },
        { beforeOrders: encodeAuditCursor({ at: '2026-07-06T00:00:00.000Z', id: 'zzzz' }) },
      ),
    );
    const body = (await res.json()) as { events: Array<{ at: string }> };
    // createdAt (01-01) < cursor.at (07-06) → row passes the filter.
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.at).toBe('2026-01-01T00:00:00.000Z');

    // Structural: the captured orders predicate is the compound keyset
    // `ts < at OR (ts = at AND id < id)` on (orders.createdAt, orders.id).
    const orderWhere = state.whereCalls.find((c) => c.table === 'orders')?.cond;
    expect(extractCompoundCursor(orderWhere)).toBeDefined();
    const orderOr = (orderWhere as { conds: unknown[] }).conds.find(
      (c): c is { __or: true; conds: unknown[] } =>
        typeof c === 'object' && c !== null && '__or' in c,
    );
    const ltTs = orderOr?.conds.find(
      (c): c is { __lt: true; col: unknown } => typeof c === 'object' && c !== null && '__lt' in c,
    );
    expect(ltTs?.col).toBe(TABLES.orders.createdAt);
    const andNode = orderOr?.conds.find(
      (c): c is { __and: true; conds: unknown[] } =>
        typeof c === 'object' && c !== null && '__and' in c,
    );
    const ltId = andNode?.conds.find(
      (c): c is { __lt: true; col: unknown } => typeof c === 'object' && c !== null && '__lt' in c,
    );
    expect(ltId?.col).toBe(TABLES.orders.id); // tiebreaker is orders.id
  });

  // ── Cross-source completeness under uneven density (distinct ts) ──
  it('cross-source completeness: no row lost paging uneven-density sources to exhaustion', async () => {
    state.orderRows = [
      makeOrder('order-a', '2026-01-01T00:00:00Z'),
      makeOrder('order-b', '2026-02-01T00:00:00Z'),
    ];
    // 12 ledger rows on 2026-07-01 .. 2026-07-12 (distinct days).
    state.ledgerRows = Array.from({ length: 12 }, (_, i) => {
      const day = i + 1;
      return {
        id: `tx-${String(day).padStart(2, '0')}`,
        userId: USER_ID,
        type: 'cashback',
        amountMinor: 100n,
        currency: 'USD',
        referenceType: null,
        referenceId: null,
        createdAt: new Date(`2026-07-${String(day).padStart(2, '0')}T00:00:00Z`),
      };
    });

    const { seenKeys, pages, firstPageCursors } = await walkToExhaustion();

    // Per-source cursors: after page 1 the ledger cursor is ITS OWN
    // floor (07-05), not the cross-source min (the 01-01 order). Orders
    // is already exhausted (2 < limit) so its cursor is null.
    expect(firstPageCursors?.ledger?.at).toBe('2026-07-05T00:00:00.000Z');
    expect(firstPageCursors?.orders).toBeNull();

    const expected = [
      'order-a',
      'order-b',
      ...Array.from({ length: 12 }, (_, i) => `tx-${String(i + 1).padStart(2, '0')}`),
    ].sort();
    expect([...seenKeys].sort()).toEqual(expected);
    expect(seenKeys.length).toBe(new Set(seenKeys).size); // no duplicates
    expect(pages).toBe(2);
  });

  // ── The residual P1: TIE-boundary loss (many rows share one ts) ──
  //
  // `revokeAllRefreshTokensForUser` stamps ONE `revokedAt` on every
  // live session in a single UPDATE, so a mass "sign out everywhere" /
  // admin incident revoke of > limit sessions produces > 8 rows with
  // IDENTICAL revokedAt. A naive `revokedAt < cursor` would return 8,
  // set the cursor to that shared timestamp, then `< cursor` on page 2
  // returns 0 — the overflow revocations vanish. The compound
  // `(revokedAt, jti)` cursor recovers them.
  it('tie boundary (sessions): >limit revocations sharing one revokedAt are all returned', async () => {
    const sharedRevokedAt = new Date('2026-07-05T00:00:00Z');
    state.sessionRows = Array.from({ length: 10 }, (_, i) => ({
      jti: `jti-${String(i).padStart(2, '0')}`,
      createdAt: new Date('2026-06-01T00:00:00Z'),
      revokedAt: sharedRevokedAt, // one UPDATE stamped them all
    }));

    const { seenKeys, pages } = await walkToExhaustion();

    const expected = Array.from(
      { length: 10 },
      (_, i) => `jti-${String(i).padStart(2, '0')}`,
    ).sort();
    expect([...seenKeys].sort()).toEqual(expected);
    expect(seenKeys.length).toBe(new Set(seenKeys).size); // no duplicates
    expect(pages).toBe(2); // 8 then 2, across the tie boundary
  });

  it('tie boundary (ledger): >limit credits sharing one createdAt are all returned', async () => {
    const sharedCreatedAt = new Date('2026-07-05T00:00:00Z');
    state.ledgerRows = Array.from({ length: 10 }, (_, i) => ({
      id: `tx-${String(i).padStart(2, '0')}`,
      userId: USER_ID,
      type: 'interest',
      amountMinor: 3n,
      currency: 'GBP',
      referenceType: null,
      referenceId: null,
      createdAt: sharedCreatedAt, // an interest-mint-style transaction-stable now()
    }));

    const { seenKeys, pages } = await walkToExhaustion();

    const expected = Array.from(
      { length: 10 },
      (_, i) => `tx-${String(i).padStart(2, '0')}`,
    ).sort();
    expect([...seenKeys].sort()).toEqual(expected);
    expect(seenKeys.length).toBe(new Set(seenKeys).size);
    expect(pages).toBe(2);
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

  it('a later page (a before* cursor present) re-queries ONLY cursored sources + omits the OTP snapshot', async () => {
    await adminUserAuditTimelineHandler(
      makeCtx(
        { userId: USER_ID },
        { beforeLedger: encodeAuditCursor({ at: '2026-07-01T00:00:00.000Z', id: 'tx-1' }) },
      ),
    );
    const tables = state.limitCalls.map((c) => c.table).sort();
    // users (subject lookup) + credit_transactions (the cursored
    // source) only — NOT orders/payouts/sessions/admin_actions, and
    // NOT otp_attempt_counters (the snapshot is page-1-only).
    expect(tables).toEqual(['credit_transactions', 'users']);
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
  // snapshot) must stay under the global bulk-read threshold.
  it('a maximally-populated default response stays under the CF-10 bulk-read threshold', async () => {
    const DEFAULT = 8;
    state.adminActionRows = Array.from({ length: DEFAULT }, (_, i) => ({
      cursorId: `idem-${i}`,
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
    state.orderRows = Array.from({ length: DEFAULT }, (_, i) =>
      makeOrder(`order-${i}`, new Date(Date.now() - i * 1000).toISOString()),
    );
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
      { lockedUntil: new Date(Date.now() + 60_000), failedAttempts: 5, updatedAt: new Date() },
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

/**
 * Drives the client's per-source paging loop to exhaustion: page 1 has
 * no cursors; each subsequent page echoes the prior `nextCursors`.
 * Returns the accumulated per-row keys (ledger→transactionId,
 * session→jti, order/payout→refId), the page count, and page 1's
 * cursors.
 */
async function walkToExhaustion(): Promise<{
  seenKeys: string[];
  pages: number;
  firstPageCursors: AdminAuditTimelineCursors | null;
}> {
  const seenKeys: string[] = [];
  let cursors: AdminAuditTimelineCursors | null = null;
  let pages = 0;
  let firstPageCursors: AdminAuditTimelineCursors | null = null;
  for (;;) {
    pages += 1;
    expect(pages).toBeLessThanOrEqual(10); // guard against a runaway loop
    const query = cursors === null ? {} : cursorsToQuery(cursors);
    const res = await adminUserAuditTimelineHandler(makeCtx({ userId: USER_ID }, query));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{ kind: string; refId: string | null; detail: Record<string, unknown> }>;
      nextCursors: AdminAuditTimelineCursors;
    };
    for (const e of body.events) {
      if (e.kind === 'ledger') seenKeys.push(String(e.detail.transactionId));
      else if (e.kind === 'session_revoked') seenKeys.push(String(e.detail.jti));
      else seenKeys.push(String(e.refId));
    }
    if (firstPageCursors === null) firstPageCursors = body.nextCursors;
    const more = Object.values(body.nextCursors).some((v) => v !== null);
    if (!more) break;
    cursors = body.nextCursors;
  }
  return { seenKeys, pages, firstPageCursors };
}

function makeOrder(id: string, createdAtIso: string): Record<string, unknown> {
  return {
    id,
    state: 'fulfilled',
    currency: 'USD',
    chargeCurrency: 'USD',
    chargeMinor: 1000n,
    merchantId: 'merchant-1',
    failureReason: null,
    createdAt: new Date(createdAtIso),
    paidAt: null,
    procuredAt: null,
    fulfilledAt: null,
    failedAt: null,
  };
}
