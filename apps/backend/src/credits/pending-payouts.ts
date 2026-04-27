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

// Admin-side `pending_payouts` reads (`listPayoutsForAdmin`,
// `getPayoutForAdmin`, `getPayoutByOrderId`) live in
// `./pending-payouts-admin.ts`. Re-exported below so existing
// import sites keep resolving against
// `'../credits/pending-payouts.js'`.
export {
  listPayoutsForAdmin,
  getPayoutForAdmin,
  getPayoutByOrderId,
} from './pending-payouts-admin.js';

// User-scoped pending-payout reads live in
// `./pending-payouts-user.ts`. Re-exported here so the wide
// network of call sites — handlers, tests, OpenAPI registrations
// — keeps importing from the historical
// `'../credits/pending-payouts.js'` path without a re-target.
export {
  listPayoutsForUser,
  pendingPayoutsSummaryForUser,
  getPayoutForUser,
  getPayoutByOrderIdForUser,
  type PendingPayoutsSummaryRow,
} from './pending-payouts-user.js';
