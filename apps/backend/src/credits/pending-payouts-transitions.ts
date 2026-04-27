/**
 * Pending-payout state transitions (ADR 015 / 016).
 *
 * Lifted out of `./pending-payouts.ts` so the row-by-row state
 * transitions live separately from the queue / creation primitives.
 * Each function here is an `UPDATE pending_payouts ... WHERE
 * state = <expected> RETURNING` — the WHERE-state guard is the lock,
 * so two workers racing on the same row can't both advance it.
 *
 * Five transitions live here:
 *
 *   - `markPayoutSubmitted` — `pending → submitted` (worker claim)
 *   - `markPayoutConfirmed` — `submitted → confirmed` (Horizon-side)
 *   - `markPayoutFailed`    — `pending|submitted → failed`
 *   - `reclaimSubmittedPayout` — A2-602 watchdog re-claim of stuck
 *     `submitted` rows (CAS on attempts; same state, fresh stamp)
 *   - `resetPayoutToPending` — admin / ops `failed → pending`
 *
 * Re-exported from `./pending-payouts.ts` so the wide network of
 * existing import sites (worker, tests, admin handlers) keeps
 * resolving against the historical path.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pendingPayouts } from '../db/schema.js';

export type PendingPayout = typeof pendingPayouts.$inferSelect;

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
