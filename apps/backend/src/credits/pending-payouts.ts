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
 * replay of the same order via the partial unique index
 * `pending_payouts_order_unique (order_id) WHERE kind='order_cashback'`
 * — a second call returns null and leaves the prior row untouched.
 * (Partial since migration 0038 / ADR 036 so a redeemed order can
 * also carry its `kind='burn'` row; the ON CONFLICT target must name
 * the index predicate to match.)
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
    .onConflictDoNothing({
      target: pendingPayouts.orderId,
      where: sql`kind = 'order_cashback'`,
    })
    .returning();
  return row ?? null;
}

/**
 * ADR 036: sum of `amount_stroops` across in-flight `kind='burn'`
 * rows for one asset. "In-flight" = pending / submitted / failed —
 * the corresponding LOOP has already been debited from the
 * `user_credits` mirror (markOrderPaid) and is parked at the
 * deposit/operator account awaiting the issuer-return burn, so it is
 * no longer user-circulating but still counts toward on-chain
 * issuance until the burn confirms. The asset-drift watcher subtracts
 * this from circulation so redemptions don't read as drift. Confirmed
 * burns are excluded — the issuer-return already removed them from
 * circulation on-chain.
 */
export async function sumInFlightBurnStroops(args: {
  assetCode: string;
  assetIssuer: string;
}): Promise<bigint> {
  const [row] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${pendingPayouts.amountStroops}), 0)::text`,
    })
    .from(pendingPayouts)
    .where(
      sql`${pendingPayouts.kind} = 'burn'
        AND ${pendingPayouts.assetCode} = ${args.assetCode}
        AND ${pendingPayouts.assetIssuer} = ${args.assetIssuer}
        AND ${pendingPayouts.state} IN ('pending', 'submitted', 'failed')`,
    );
  return BigInt(row?.total ?? '0');
}

/**
 * ADR 031 / ADR 036 Phase D: sum of `amount_stroops` across in-flight
 * `kind='interest_mint'` rows for one asset. Mirror image of the burn
 * sum above: the nightly interest txn credits the `user_credits`
 * mirror AND enqueues the issuer-signed mint in one transaction, so
 * until the mint confirms the mirror is AHEAD of on-chain circulation
 * by the queued amount. The asset-drift watcher ADDS this to the
 * circulation side of its equation so an in-flight mint reads as
 * drift-neutral. Confirmed mints are excluded — the issuer payment
 * raised on-chain circulation itself. `failed` rows stay included
 * (mirror credited, chain pending ops intervention) — same posture
 * as in-flight burns.
 */
export async function sumInFlightInterestMintStroops(args: {
  assetCode: string;
  assetIssuer: string;
}): Promise<bigint> {
  const [row] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${pendingPayouts.amountStroops}), 0)::text`,
    })
    .from(pendingPayouts)
    .where(
      sql`${pendingPayouts.kind} = 'interest_mint'
        AND ${pendingPayouts.assetCode} = ${args.assetCode}
        AND ${pendingPayouts.assetIssuer} = ${args.assetIssuer}
        AND ${pendingPayouts.state} IN ('pending', 'submitted', 'failed')`,
    );
  return BigInt(row?.total ?? '0');
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
 *
 * CF-14 (x-concurrency-financial X-2): the candidate read takes a
 * `FOR UPDATE SKIP LOCKED` row lock. All Loop background workers run
 * in-process on EVERY Fly machine — there is no leader election or
 * `[processes] worker count=1`, and `auto_start_machines=true` boots a
 * second machine under request load. With a plain `SELECT`, two
 * machines' payout workers read the SAME candidate set every tick;
 * the per-row `markPayoutSubmitted` state-CAS still guarantees a row
 * is claimed by at most one of them (no double-pay), but both machines
 * then sign txs against the SAME operator account and collide on the
 * Stellar sequence number → `tx_bad_seq` churn that burns the attempt
 * budget and can drive legit payouts to terminal `failed` under scale.
 *
 * `FOR UPDATE SKIP LOCKED` closes the read→claim window: a row another
 * worker is mid-claim on (locked but not yet committed `submitted`) is
 * SKIPPED here, so concurrent instances pull disjoint candidate sets
 * instead of fighting over the same rows. The durable claim is still
 * the per-row state-CAS in `payOne`; this lock is what stops the two
 * instances from each running the (wasteful) trustline + idempotency
 * Horizon reads on a row the other is about to win, and — in the
 * common case where the backlog fits one tick's batch — leaves the
 * second instance with nothing to pick, so the operator sequence stays
 * serialised.
 *
 * Scope (proportionate, per the finding): this is a row-level claim,
 * not full leader election. With a backlog larger than one batch, two
 * instances can still claim DISJOINT batches and submit concurrently —
 * the residual sequence-collision risk a single-flight worker
 * (`pg_advisory_lock` leader / `[processes] worker count=1`) would
 * close. That stays deferred; `min_machines_running=1` plus the small
 * per-tick batch bounds it. The lock keeps single-instance behaviour
 * identical (it only ever changes what a concurrent instance sees).
 */
export async function listClaimablePayouts(opts: {
  limit?: number;
  staleSeconds: number;
  maxAttempts: number;
}): Promise<PendingPayout[]> {
  const limit = opts.limit ?? 20;
  return (
    db
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
      .limit(limit)
      // CF-14: skip rows another instance's payout worker is mid-claim
      // on. See the docstring above for why this is the row-level claim
      // the finding asks for.
      .for('update', { skipLocked: true })
  );
}

// State transitions (`reclaimSubmittedPayout`, `markPayoutSubmitted`,
// `recordPayoutTxHash`, `markPayoutConfirmed`, `markPayoutFailed`,
// `resetPayoutToPending`) live in `./pending-payouts-transitions.ts`.
// Re-exported below so the wide network of import sites — submit
// worker, watchdog, admin handlers, tests — keeps resolving against the
// historical `'../credits/pending-payouts.js'` path.
export {
  reclaimSubmittedPayout,
  markPayoutSubmitted,
  recordPayoutTxHash,
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
