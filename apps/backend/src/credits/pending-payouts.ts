/**
 * Pending-payout repo (ADR 015).
 *
 * Writes the intent + reads/transitions rows for the submit worker.
 * Every state transition is a state-guarded UPDATE: `pending →
 * submitted` only advances rows that are still in `pending`, so two
 * workers racing on the same row can't double-submit.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pendingPayouts } from '../db/schema.js';

export type PendingPayout = typeof pendingPayouts.$inferSelect;

/**
 * Shape the repo expects — matches the `PayoutIntent` returned by
 * `credits/payout-builder.ts` (landing in a separate PR). Kept local
 * here as a minimal interface so this module doesn't take a type-only
 * import dependency on that file, letting each layer merge independently.
 */
interface PayoutIntent {
  to: string;
  assetCode: string;
  assetIssuer: string;
  amountStroops: bigint;
  memoText: string;
}

/**
 * Writes a pending payout row from an intent. Idempotent against a
 * replay of the same order via the UNIQUE(order_id) index — a second
 * call returns null and leaves the prior row untouched.
 */
export async function insertPayout(args: {
  userId: string;
  orderId: string;
  intent: PayoutIntent;
}): Promise<PendingPayout | null> {
  const [row] = await db
    .insert(pendingPayouts)
    .values({
      userId: args.userId,
      orderId: args.orderId,
      assetCode: args.intent.assetCode,
      assetIssuer: args.intent.assetIssuer,
      toAddress: args.intent.to,
      amountStroops: args.intent.amountStroops,
      memoText: args.intent.memoText,
    })
    .onConflictDoNothing({ target: pendingPayouts.orderId })
    .returning();
  return row ?? null;
}

/**
 * Returns the oldest pending payouts, newest-paid-first a bad idea —
 * an incident backlog should drain in the order the orders fulfilled.
 */
export async function listPendingPayouts(limit = 20): Promise<PendingPayout[]> {
  return db
    .select()
    .from(pendingPayouts)
    .where(eq(pendingPayouts.state, 'pending'))
    .orderBy(asc(pendingPayouts.createdAt))
    .limit(limit);
}

/**
 * A2-602 watchdog: same as `listPendingPayouts` but also returns rows
 * stuck in `submitted` for longer than `staleSeconds` with attempts
 * still under `maxAttempts`. The worker re-runs them through the
 * idempotency pre-check — if the prior submit landed we converge to
 * `confirmed`, otherwise a fresh submit is issued with a new sequence.
 *
 * Without this, a row that entered `submitted` but never reached
 * `confirmed` (pod crash mid-submit, Horizon blackhole, mark-confirmed
 * DB blip) sits forever: `listPendingPayouts` filters it out, and the
 * old `markPayoutSubmitted(state='pending')` guard refuses to re-claim.
 *
 * Ordering: pending first (fresh work) then stale submitted (watchdog
 * recovery). Both ordered by createdAt ASC so a backlog drains FIFO.
 */
export async function listClaimablePayouts(opts: {
  limit?: number;
  staleSeconds: number;
  maxAttempts: number;
}): Promise<PendingPayout[]> {
  const limit = opts.limit ?? 20;
  return db
    .select()
    .from(pendingPayouts)
    .where(
      sql`(${pendingPayouts.state} = 'pending')
        OR (
          ${pendingPayouts.state} = 'submitted'
          AND ${pendingPayouts.submittedAt} < NOW() - make_interval(secs => ${opts.staleSeconds})
          AND ${pendingPayouts.attempts} < ${opts.maxAttempts}
        )`,
    )
    .orderBy(
      // `pending` before `submitted` so fresh work drains before the
      // watchdog backlog. `<` orders alphabetically so 'pending' >
      // 'submitted' — flip with a CASE.
      sql`CASE WHEN ${pendingPayouts.state} = 'pending' THEN 0 ELSE 1 END`,
      asc(pendingPayouts.createdAt),
    )
    .limit(limit);
}

/**
 * A2-602 watchdog re-claim: a row already in `submitted` whose
 * idempotency pre-check found no prior landed payment needs a fresh
 * submit. We bump `attempts`, reset `submittedAt` to NOW, and CAS on
 * the previous attempts value so two workers racing on the same stale
 * row can't both proceed to submit.
 *
 * Returns the updated row on success, null on a race (the other worker
 * already re-claimed). The `state='submitted'` guard means this is
 * only ever a no-op state change (submitted → submitted) — the only
 * side-effects are attempts+1 and a fresh submittedAt stamp.
 */
export async function reclaimSubmittedPayout(args: {
  id: string;
  expectedAttempts: number;
}): Promise<PendingPayout | null> {
  const [row] = await db
    .update(pendingPayouts)
    .set({
      submittedAt: sql`NOW()`,
      attempts: sql`${pendingPayouts.attempts} + 1`,
    })
    .where(
      and(
        eq(pendingPayouts.id, args.id),
        eq(pendingPayouts.state, 'submitted'),
        eq(pendingPayouts.attempts, args.expectedAttempts),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Admin-facing list across any state + cursor pagination. Newest
 * first (admin UI pattern — you want to see the most recent failures
 * first when you open the page). `before` is the ISO `created_at` of
 * the last row the client has rendered; next page fetches rows older
 * than that. Limit clamps 1..100.
 */
export async function listPayoutsForAdmin(opts: {
  state?: string;
  userId?: string;
  assetCode?: string;
  before?: Date;
  limit?: number;
}): Promise<PendingPayout[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const conditions = [];
  if (opts.state !== undefined) conditions.push(eq(pendingPayouts.state, opts.state));
  if (opts.userId !== undefined) conditions.push(eq(pendingPayouts.userId, opts.userId));
  if (opts.assetCode !== undefined) conditions.push(eq(pendingPayouts.assetCode, opts.assetCode));
  if (opts.before !== undefined) conditions.push(sql`${pendingPayouts.createdAt} < ${opts.before}`);
  const where = conditions.length === 0 ? undefined : and(...conditions);
  const q = db.select().from(pendingPayouts);
  const filtered = where === undefined ? q : q.where(where);
  return filtered.orderBy(sql`${pendingPayouts.createdAt} DESC`).limit(limit);
}

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
  if (opts.before !== undefined) conditions.push(sql`${pendingPayouts.createdAt} < ${opts.before}`);
  return db
    .select()
    .from(pendingPayouts)
    .where(and(...conditions))
    .orderBy(sql`${pendingPayouts.createdAt} DESC`)
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
 * State-guarded transition: `pending → submitted`. Bumps `attempts`
 * and stamps `submitted_at`. Returns null when another worker beat us
 * to the row (idempotent).
 */
export async function markPayoutSubmitted(id: string): Promise<PendingPayout | null> {
  const [row] = await db
    .update(pendingPayouts)
    .set({
      state: 'submitted',
      submittedAt: sql`NOW()`,
      attempts: sql`${pendingPayouts.attempts} + 1`,
    })
    .where(and(eq(pendingPayouts.id, id), eq(pendingPayouts.state, 'pending')))
    .returning();
  return row ?? null;
}

/**
 * State-guarded transition: `submitted → confirmed` with the Stellar
 * tx hash. A Horizon-side confirmation watcher calls this once the
 * tx is sealed into a ledger.
 */
export async function markPayoutConfirmed(args: {
  id: string;
  txHash: string;
}): Promise<PendingPayout | null> {
  const [row] = await db
    .update(pendingPayouts)
    .set({
      state: 'confirmed',
      confirmedAt: sql`NOW()`,
      txHash: args.txHash,
      lastError: null,
    })
    .where(and(eq(pendingPayouts.id, args.id), eq(pendingPayouts.state, 'submitted')))
    .returning();
  return row ?? null;
}

/**
 * State-guarded transition: from `pending` OR `submitted` → `failed`.
 * A submit that throws before the Stellar tx is accepted should drop
 * to `failed` without leaving the row in `submitted` (which would
 * falsely claim the payment is in-flight). The worker records the
 * error so ops can see why the row stuck.
 *
 * When retry is desired instead of a terminal fail, use
 * `resetPayoutToPending` — that's an admin / ops action, not a
 * worker-level move.
 */
export async function markPayoutFailed(args: {
  id: string;
  reason: string;
}): Promise<PendingPayout | null> {
  const [row] = await db
    .update(pendingPayouts)
    .set({
      state: 'failed',
      failedAt: sql`NOW()`,
      lastError: args.reason.slice(0, 500),
    })
    .where(
      and(eq(pendingPayouts.id, args.id), sql`${pendingPayouts.state} IN ('pending', 'submitted')`),
    )
    .returning();
  return row ?? null;
}

/**
 * Resets a `failed` row back to `pending` so the worker retries it on
 * the next tick. Admin-only; the worker itself should never call this
 * (unbounded-retry would mask real issues).
 */
export async function resetPayoutToPending(id: string): Promise<PendingPayout | null> {
  const [row] = await db
    .update(pendingPayouts)
    .set({
      state: 'pending',
      failedAt: null,
      lastError: null,
    })
    .where(and(eq(pendingPayouts.id, id), eq(pendingPayouts.state, 'failed')))
    .returning();
  return row ?? null;
}

/**
 * Single-row lookup for the admin drill-down (complement to the list
 * at `listPayoutsForAdmin`). Returns null when the id matches nothing;
 * the handler turns that into a 404.
 */
export async function getPayoutForAdmin(id: string): Promise<PendingPayout | null> {
  const [row] = await db.select().from(pendingPayouts).where(eq(pendingPayouts.id, id)).limit(1);
  return row ?? null;
}

/**
 * Order-id lookup. `pending_payouts.order_id` is UNIQUE, so at most
 * one row matches. Returns null when the order has no payout row yet
 * (e.g. cashback hasn't been issued, the order is still pending, or
 * the payout builder deliberately skipped this order).
 *
 * Ops uses this to jump from an order-support ticket straight to the
 * payout state instead of fishing for the payout id in the list.
 */
export async function getPayoutByOrderId(orderId: string): Promise<PendingPayout | null> {
  const [row] = await db
    .select()
    .from(pendingPayouts)
    .where(eq(pendingPayouts.orderId, orderId))
    .limit(1);
  return row ?? null;
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
