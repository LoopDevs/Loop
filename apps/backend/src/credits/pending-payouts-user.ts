/**
 * User-scoped pending-payout reads (ADR 015).
 *
 * Lifted out of `apps/backend/src/credits/pending-payouts.ts`.
 * Four caller-scoped read functions + their PendingPayoutsSummaryRow
 * shape — every one of them takes a `userId` arg and filters on it
 * via the schema\'s `pendingPayouts.userId` predicate.
 *
 * Cohabit with the worker / admin / write-side code in the parent
 * file made the file long without the user-side and worker-side
 * pieces actually needing each other; this slice gives the user-
 * facing handler module (`./users/pending-payouts-handler.ts`) a
 * smaller import surface and keeps user-side query patterns
 * separate from worker race-condition logic.
 */
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pendingPayouts } from '../db/schema.js';
import { type PendingPayout } from './pending-payouts.js';

/**
 * User-scoped variant — returns only rows owned by `userId`. Same
 * cursor pagination as the admin list (newest createdAt first). Used
 * by `GET /api/users/me/pending-payouts` so each user can see their
 * own queued / submitted / confirmed / failed on-chain payouts, not
 * just the off-chain ledger entries (ADR 015).
 */
export async function listPayoutsForUser(
  userId: string,
  opts: {
    state?: string;
    before?: Date;
    limit?: number;
  } = {},
): Promise<PendingPayout[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const conditions = [eq(pendingPayouts.userId, userId)];
  if (opts.state !== undefined) conditions.push(eq(pendingPayouts.state, opts.state));
  // A2-1610: typed `lt()` + `desc()` — postgres-js can't bind a Date
  // through the raw sql interpolator. See `audit-tail-csv.ts`.
  if (opts.before !== undefined) conditions.push(lt(pendingPayouts.createdAt, opts.before));
  return db
    .select()
    .from(pendingPayouts)
    .where(and(...conditions))
    .orderBy(desc(pendingPayouts.createdAt))
    .limit(limit);
}

export interface PendingPayoutsSummaryRow {
  assetCode: string;
  state: string;
  count: number;
  totalStroops: bigint;
  /** Unix ms of the oldest pending/submitted createdAt in this bucket. */
  oldestCreatedAtMs: number;
}

/**
 * Summary aggregate of a user's pending_payouts rows bucketed by
 * (asset_code, state). Reads only `state IN ('pending', 'submitted')`
 * — confirmed rows live in the ledger, failed rows belong to the
 * admin-retry flow, neither represent "still-awaited cashback."
 *
 * Returned rows are empty when the user has no in-flight payouts.
 */
export async function pendingPayoutsSummaryForUser(
  userId: string,
): Promise<PendingPayoutsSummaryRow[]> {
  const rows = await db
    .select({
      assetCode: pendingPayouts.assetCode,
      state: pendingPayouts.state,
      count: sql<string>`COUNT(*)::text`,
      totalStroops: sql<string>`COALESCE(SUM(${pendingPayouts.amountStroops}), 0)::text`,
      oldestCreatedAt: sql<Date>`MIN(${pendingPayouts.createdAt})`,
    })
    .from(pendingPayouts)
    .where(
      and(
        eq(pendingPayouts.userId, userId),
        sql`${pendingPayouts.state} IN ('pending', 'submitted')`,
      ),
    )
    .groupBy(pendingPayouts.assetCode, pendingPayouts.state);
  return rows.map((r) => ({
    assetCode: r.assetCode,
    state: r.state,
    count: Number(r.count),
    totalStroops: BigInt(r.totalStroops),
    oldestCreatedAtMs: r.oldestCreatedAt.getTime(),
  }));
}

/**
 * User-scoped single-row lookup for the caller's drill-down. The
 * `(id, userId)` predicate guarantees the row belongs to the caller
 * — a mismatch returns null rather than revealing the row's
 * existence, which the handler turns into a 404.
 */
export async function getPayoutForUser(id: string, userId: string): Promise<PendingPayout | null> {
  const [row] = await db
    .select()
    .from(pendingPayouts)
    .where(and(eq(pendingPayouts.id, id), eq(pendingPayouts.userId, userId)))
    .limit(1);
  return row ?? null;
}

/**
 * User-scoped per-order payout lookup — "for my order X, is there a
 * payout row, and what's its state?". `(order_id, user_id)` predicate
 * guarantees the row belongs to the caller; a mismatch (another
 * user's order id guessed) returns null so the handler can 404
 * without confirming the order exists.
 */
export async function getPayoutByOrderIdForUser(
  orderId: string,
  userId: string,
): Promise<PendingPayout | null> {
  const [row] = await db
    .select()
    .from(pendingPayouts)
    .where(and(eq(pendingPayouts.orderId, orderId), eq(pendingPayouts.userId, userId)))
    .limit(1);
  return row ?? null;
}
