/**
 * Pending-payout repo (ADR 015).
 *
 * Writes the creation intent + reads queue rows for the submit
 * worker. State transitions (mark-submitted / confirmed / failed /
 * reclaim / reset-to-pending) live in
 * `./pending-payouts-transitions.ts` and are re-exported below so
 * the historical entry-point keeps the same export surface.
 */
import { asc, eq, sql } from 'drizzle-orm';
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

// State transitions (`reclaimSubmittedPayout`, `markPayoutSubmitted`,
// `markPayoutConfirmed`, `markPayoutFailed`, `resetPayoutToPending`)
// live in `./pending-payouts-transitions.ts`. Re-exported below so
// the wide network of import sites — submit worker, watchdog,
// admin handlers, tests — keeps resolving against the historical
// `'../credits/pending-payouts.js'` path.
export {
  reclaimSubmittedPayout,
  markPayoutSubmitted,
  markPayoutConfirmed,
  markPayoutFailed,
  resetPayoutToPending,
} from './pending-payouts-transitions.js';

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
