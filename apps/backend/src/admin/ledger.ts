/**
 * Fleet-wide admin ledger browser (ADR 037 §4.2 / A5-8).
 *
 * `GET /api/admin/ledger` — paginated, filterable list of
 * `credit_transactions` rows ACROSS every user, newest first. Before
 * this endpoint the ledger was browsable per-user only
 * (`/api/admin/users/:userId/credit-transactions`); investigating a
 * cross-user money question (a drift, a dispute, a reconciliation
 * pass) meant a raw SQL query. This is that query, exposed
 * read-only.
 *
 * Filters (all optional, combinable): `userId`, `type` (one of
 * `CREDIT_TRANSACTION_TYPES`), `referenceType` + `referenceId`
 * (e.g. `order` / `<uuid>`, `payout` / `<uuid>`), `since` (inclusive
 * lower bound) and `before` (exclusive upper bound / keyset cursor —
 * same convention as `/api/admin/orders` and the per-user
 * credit-transactions endpoint: pass the last row's `createdAt` to
 * page older). `limit` clamps to [1, 200], default 50 — bigger than
 * the per-user endpoint's [1, 100]/20 default because a fleet-wide
 * triage pass typically wants a wider first look.
 *
 * **Bounded + indexed, never an unbounded scan (S4-6).** Every query
 * shape below terminates on `LIMIT` and rides an index that already
 * matches its filter + the `ORDER BY created_at DESC`, so none of
 * them can degrade into a full-table sort:
 *
 *   - `userId` set              → `credit_transactions_user_created (user_id, created_at)`
 *   - `type` set (no `userId`)  → `credit_transactions_type_created (type, created_at)`
 *   - `referenceType`/`Id` set  → `credit_transactions_reference (reference_type, reference_id)`
 *     (reference lookups are inherently narrow — at most a handful
 *     of rows per order/payout — so the missing `created_at` tail on
 *     this index is immaterial; there's nothing left to sort)
 *   - none of the above         → `credit_transactions_created_at` (migration 0058, mirrors
 *     PERF-005's `orders_created_at`) — a plain btree so the fully
 *     unfiltered / date-range-only browse still serves as a bounded
 *     backward index scan instead of a seq-scan + sort.
 *
 * This is a READ-ONLY endpoint — no mutation, no balance write, no
 * idempotency envelope. Support-tier (ADR 037 §3: "ledger" is listed
 * among the read views both roles get; the sibling fleet-wide reads
 * — `/api/admin/orders`, `/api/admin/reconciliation` — are also
 * blanket riders with no explicit admin gate). The route mount in
 * `routes/admin-support-ops.ts` declares `requireStaff('support')`
 * explicitly (redundant with the namespace blanket) to match that
 * file's own convention of making every mount's tier reviewable
 * in-place.
 */
import type { Context } from 'hono';
import { and, desc, eq, gte, lt } from 'drizzle-orm';
import { CREDIT_TRANSACTION_TYPES, type AdminLedgerEntry } from '@loop/shared';
import { UUID_RE } from '../uuid.js';
import { db } from '../db/client.js';
import { creditTransactions } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-ledger' });

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// referenceType is a free-form short tag written by internal callers
// only ('order' | 'payout' | 'admin_adjustment' today, per
// db/schema/credits.ts's writers) — shape-validate rather than
// enum-pin so a future writer's new tag doesn't need an endpoint
// change to become filterable.
const REFERENCE_TYPE_RE = /^[a-z_]{1,64}$/;

export interface AdminLedgerListResponse {
  transactions: AdminLedgerEntry[];
}

interface DbRow {
  id: string;
  userId: string;
  type: string;
  amountMinor: bigint;
  currency: string;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: Date;
}

export async function adminLedgerHandler(c: Context): Promise<Response> {
  const userIdRaw = c.req.query('userId');
  if (userIdRaw !== undefined && !UUID_RE.test(userIdRaw)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a UUID' }, 400);
  }

  const typeRaw = c.req.query('type');
  if (
    typeRaw !== undefined &&
    !(CREDIT_TRANSACTION_TYPES as ReadonlyArray<string>).includes(typeRaw)
  ) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: `type must be one of: ${CREDIT_TRANSACTION_TYPES.join(', ')}`,
      },
      400,
    );
  }

  const referenceTypeRaw = c.req.query('referenceType');
  if (referenceTypeRaw !== undefined && !REFERENCE_TYPE_RE.test(referenceTypeRaw)) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: 'referenceType must be 1-64 lowercase/underscore chars',
      },
      400,
    );
  }

  // referenceId is a free-form id (order/payout uuid, or an
  // admin_adjustment-generated id) — shape-check length only, same
  // posture as `admin/orders.ts`'s ctxOperatorId filter.
  const referenceIdRaw = c.req.query('referenceId');
  if (
    referenceIdRaw !== undefined &&
    (referenceIdRaw.length === 0 || referenceIdRaw.length > 128)
  ) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'referenceId is malformed' }, 400);
  }

  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? String(DEFAULT_LIMIT), 10);
  const limit = Math.min(
    Math.max(Number.isNaN(parsedLimit) ? DEFAULT_LIMIT : parsedLimit, 1),
    MAX_LIMIT,
  );

  const beforeRaw = c.req.query('before');
  let before: Date | undefined;
  if (beforeRaw !== undefined && beforeRaw.length > 0) {
    const d = new Date(beforeRaw);
    if (Number.isNaN(d.getTime())) {
      return c.json(
        { code: 'VALIDATION_ERROR', message: 'before must be an ISO-8601 timestamp' },
        400,
      );
    }
    before = d;
  }

  const sinceRaw = c.req.query('since');
  let since: Date | undefined;
  if (sinceRaw !== undefined && sinceRaw.length > 0) {
    const d = new Date(sinceRaw);
    if (Number.isNaN(d.getTime())) {
      return c.json(
        { code: 'VALIDATION_ERROR', message: 'since must be an ISO-8601 timestamp' },
        400,
      );
    }
    since = d;
  }

  try {
    const conditions = [];
    if (userIdRaw !== undefined) conditions.push(eq(creditTransactions.userId, userIdRaw));
    if (typeRaw !== undefined) conditions.push(eq(creditTransactions.type, typeRaw));
    if (referenceTypeRaw !== undefined) {
      conditions.push(eq(creditTransactions.referenceType, referenceTypeRaw));
    }
    if (referenceIdRaw !== undefined) {
      conditions.push(eq(creditTransactions.referenceId, referenceIdRaw));
    }
    if (since !== undefined) conditions.push(gte(creditTransactions.createdAt, since));
    // A2-1610: typed `lt()` instead of a raw sql template — postgres-js
    // can't bind a Date through the sql interpolator. Same fix as
    // `user-credit-transactions.ts` / `audit-tail-csv.ts` / `adjustments.ts`.
    if (before !== undefined) conditions.push(lt(creditTransactions.createdAt, before));

    const q = db.select().from(creditTransactions);
    const filtered = conditions.length === 0 ? q : q.where(and(...conditions));
    const rows = (await filtered
      .orderBy(desc(creditTransactions.createdAt))
      .limit(limit)) as DbRow[];

    const transactions: AdminLedgerEntry[] = rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      type: r.type as AdminLedgerEntry['type'],
      amountMinor: r.amountMinor.toString(),
      currency: r.currency,
      referenceType: r.referenceType,
      referenceId: r.referenceId,
      createdAt: r.createdAt.toISOString(),
    }));

    return c.json<AdminLedgerListResponse>({ transactions });
  } catch (err) {
    log.error({ err }, 'Admin ledger list failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to list ledger transactions' }, 500);
  }
}
