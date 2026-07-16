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
import { pendingPayouts, payoutTxHashes } from '../db/schema.js';

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
 * Result of {@link recordPayoutTxHash}.
 *
 * `row === null` is the historical "raced" signal — the row moved out of
 * `submitted` between claim and stamp, so the caller aborts the in-flight
 * submit (unchanged contract). `overwriteRefused` is the PAYOUT-HASHHISTORY
 * signal: a DIFFERING non-null anchor was already present, so the anchor
 * was PRESERVED and the new hash appended to `payout_tx_hashes` only —
 * the caller alerts ops (a differing re-submit hash under a landed anchor
 * is a potential double-pay to reconcile).
 */
export interface RecordTxHashResult {
  row: PendingPayout | null;
  overwriteRefused: boolean;
  /** The preserved anchor hash when `overwriteRefused`; else null. */
  existingTxHash: string | null;
}

/**
 * CF-18 + PAYOUT-HASHHISTORY: persist the deterministic tx hash on a
 * `submitted` row BEFORE the network submit lands it, and append it to the
 * append-only `payout_tx_hashes` history. State stays `submitted` (this is
 * not a confirmation — the tx may not be in a ledger yet); we only stamp
 * the hash so a later re-pick can ask Horizon "did THIS tx land?" directly,
 * with no dependence on the bounded memo-scan window.
 *
 * PAYOUT-HASHHISTORY — the anchor is DURABLE: `pending_payouts.tx_hash`
 * holds a SINGLE hash, the link to the funds that FIRST moved. Under deep
 * Horizon ingestion lag the FT-05 expiry guard can clear (a landed tx still
 * reads 404 past its timebound) and the re-submit path would sign a fresh
 * hash — the OLD behaviour OVERWROTE the anchor here, losing the durable
 * link to value that actually moved on-chain. Now:
 *
 *   - First write (`tx_hash IS NULL`): stamp the anchor — the happy path,
 *     PRESERVED EXACTLY — and append the hash to history ('first-submit').
 *   - Same hash re-recorded (a double `onSigned` in one attempt): anchor
 *     unchanged; the history insert is an `ON CONFLICT DO NOTHING` no-op.
 *   - DIFFERING non-null anchor: REFUSE to overwrite. The anchor is kept;
 *     the new hash is appended to history ('resubmit-refused') so the funds
 *     link is never lost; `overwriteRefused` is returned so the caller
 *     pages ops. The re-submit itself still proceeds (the FT-05 pre-check
 *     in `payOne` already proved it safe to re-submit) — freezing the
 *     anchor never blocks the submit, it only preserves the record.
 *
 * The read+write is wrapped in a transaction with a `FOR UPDATE` row lock,
 * so the anchor decision (and the paired history append) is serialized
 * against a concurrent confirm / fail / record — strictly stronger than the
 * prior single state-guarded UPDATE, and the `state !== 'submitted'` guard
 * preserves the exact "raced → null → abort submit" contract.
 *
 * Deliberately does NOT bump attempts or touch timestamps — it's a pure
 * hash stamp within an in-flight submit.
 */
export async function recordPayoutTxHash(args: {
  id: string;
  txHash: string;
}): Promise<RecordTxHashResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(pendingPayouts)
      .where(eq(pendingPayouts.id, args.id))
      .for('update');
    // Same guard the prior single-UPDATE encoded: only a row the worker
    // still holds in `submitted` is writable. A gone/moved row → null →
    // caller aborts the in-flight submit (unchanged contract).
    if (row === undefined || row.state !== 'submitted') {
      return { row: null, overwriteRefused: false, existingTxHash: null };
    }
    const existing = row.txHash;

    if (existing === null) {
      // Happy path (first hash write) — stamp the durable anchor.
      const [updated] = await tx
        .update(pendingPayouts)
        .set({ txHash: args.txHash })
        .where(and(eq(pendingPayouts.id, args.id), eq(pendingPayouts.state, 'submitted')))
        .returning();
      await tx
        .insert(payoutTxHashes)
        .values({
          payoutId: args.id,
          txHash: args.txHash,
          attempt: row.attempts,
          reason: 'first-submit',
        })
        .onConflictDoNothing();
      return { row: updated ?? null, overwriteRefused: false, existingTxHash: null };
    }

    if (existing === args.txHash) {
      // Idempotent re-record of the SAME hash — anchor unchanged; ensure
      // it's in history (dedup no-op via the (payout_id, tx_hash) unique).
      await tx
        .insert(payoutTxHashes)
        .values({
          payoutId: args.id,
          txHash: args.txHash,
          attempt: row.attempts,
          reason: 'first-submit',
        })
        .onConflictDoNothing();
      return { row, overwriteRefused: false, existingTxHash: existing };
    }

    // DIFFERING non-null anchor — REFUSE to overwrite. Preserve the durable
    // anchor; append the new hash so the funds link is never lost.
    await tx
      .insert(payoutTxHashes)
      .values({
        payoutId: args.id,
        txHash: args.txHash,
        attempt: row.attempts,
        reason: 'resubmit-refused',
      })
      .onConflictDoNothing();
    return { row, overwriteRefused: true, existingTxHash: existing };
  });
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
 *
 * REL-09: the `attempts` counter MUST reset to 0 as well. A row only
 * reaches terminal `failed` after `handleSubmitError`
 * (payout-worker-pay-one.ts) exhausts its budget — `attempts` is at or
 * past `LOOP_PAYOUT_MAX_ATTEMPTS`. Leaving that stale on a reset row
 * defeats the retry the admin asked for two ways: the very next
 * `handleSubmitError` computes `usedAttempts = attempts + 1 >=
 * maxAttempts` and re-fails terminally on the FIRST transient error
 * (zero effective retry budget), and if the re-submit instead stalls
 * in `submitted`, `listClaimablePayouts`'s watchdog branch (`attempts <
 * maxAttempts`) never re-claims it — stuck forever. Resetting to 0
 * restores the intended fresh budget, matching every sibling
 * reset-for-retry path (`reopenAbandonedSkip`, vault-emission /
 * -redemption resume).
 */
export async function resetPayoutToPending(id: string): Promise<PendingPayout | null> {
  const [row] = await db
    .update(pendingPayouts)
    .set({
      state: 'pending',
      failedAt: null,
      lastError: null,
      attempts: 0,
    })
    .where(
      and(
        eq(pendingPayouts.id, id),
        eq(pendingPayouts.state, 'failed'),
        sql`${pendingPayouts.compensatedAt} IS NULL`,
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * PAYOUT-TXHASHNULL-STRAND (liveness): recover a retry-EXHAUSTED
 * `submitted` row that carries NO persisted tx hash by resetting it to
 * `pending` with a fresh attempt budget.
 *
 * Such a row is stranded: `listClaimablePayouts`'s watchdog clause
 * excludes it (`attempts >= maxAttempts`) and its exhausted-reclaim clause
 * excludes it (`tx_hash IS NULL`), so no path ever re-picks it — it wedges
 * in `submitted` forever even though it is recoverable. It arises only from
 * a hard crash BETWEEN the attempts-bump commit (`markPayoutSubmitted` /
 * `reclaimSubmittedPayout`) and the `onSigned` hash-persist, repeated until
 * the budget exhausts.
 *
 * DOUBLE-PAY SAFETY — the `tx_hash IS NULL` guard is load-bearing:
 * `recordPayoutTxHash` (in `onSigned`) commits the hash STRICTLY BEFORE
 * `submitPayout` issues the network POST (payout-submit.ts: `onSigned` is
 * awaited before `server.submitTransaction`). So `tx_hash IS NULL` ⟺ no
 * Stellar tx for this row ever reached the network ⟺ no funds moved
 * on-chain — resetting can never re-pay a landed tx. The guard is enforced
 * IN the UPDATE (`state='submitted' AND tx_hash IS NULL`), so if a
 * concurrent live worker records a hash (or confirms/fails the row) in the
 * meantime, this UPDATE matches nothing → null → no reset. That same CAS is
 * the single-flight guarantee: two workers racing to recover the row see
 * exactly one win (the loser's `state='submitted'` predicate fails after the
 * winner commits `state='pending'`).
 *
 * `submitted_at` is nulled so the recovered row reads as a fresh, never-yet-
 * submitted `pending` row (the next `markPayoutSubmitted` re-stamps it);
 * `attempts` resets to 0 for the full retry budget — matching
 * `resetPayoutToPending`'s REL-09 rationale.
 */
export async function resetStrandedSubmittedToPending(id: string): Promise<PendingPayout | null> {
  const [row] = await db
    .update(pendingPayouts)
    .set({
      state: 'pending',
      submittedAt: null,
      lastError: null,
      attempts: 0,
    })
    .where(
      and(
        eq(pendingPayouts.id, id),
        eq(pendingPayouts.state, 'submitted'),
        sql`${pendingPayouts.txHash} IS NULL`,
      ),
    )
    .returning();
  return row ?? null;
}
