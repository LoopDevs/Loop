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
 * Admin-facing list across any state + cursor pagination. Newest
 * first (admin UI pattern — you want to see the most recent failures
 * first when you open the page). `before` is the ISO `created_at` of
 * the last row the client has rendered; next page fetches rows older
 * than that. Limit clamps 1..100.
 */
export async function listPayoutsForAdmin(opts: {
  state?: string;
  before?: Date;
  limit?: number;
}): Promise<PendingPayout[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const conditions = [];
  if (opts.state !== undefined) conditions.push(eq(pendingPayouts.state, opts.state));
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
