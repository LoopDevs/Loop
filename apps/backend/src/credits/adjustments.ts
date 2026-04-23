/**
 * Credit adjustment repo (ADR 017).
 *
 * Atomic `credit_transactions` insert + `user_credits` upsert for a
 * support-mediated balance change. Adjustments can be signed either
 * direction — ops credits £0.20 for a missed accrual, or debits
 * £1.00 for a bad-faith claim — but the balance row has a CHECK
 * constraint keeping the running total `>= 0`. A debit that would
 * push the balance negative raises `InsufficientBalanceError` and
 * the transaction rolls back with no row left behind.
 *
 * Reason + actor_user_id are pinned onto the ledger row — the reason
 * lands in the new `credit_transactions.reason` column (A2-908) and
 * the actor in `reference_type = 'admin_adjustment'` / `reference_id
 * = <actor uuid>`. The full story — who did it, why, what was the
 * prior and new balance — is reconstructable from the append-only
 * ledger without an edit log (ADR 017 #4). The reason used to live
 * only in the admin-idempotency snapshot, whose 24h TTL sweep would
 * erase it; persisting on the ledger row makes the promise hold past
 * the TTL.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditTransactions, userCredits } from '../db/schema.js';

export class InsufficientBalanceError extends Error {
  constructor(
    public readonly currency: string,
    public readonly balanceMinor: bigint,
    public readonly attemptedDelta: bigint,
  ) {
    super('Debit would drive balance below zero');
    this.name = 'InsufficientBalanceError';
  }
}

export interface CreditAdjustment {
  id: string;
  userId: string;
  currency: string;
  amountMinor: bigint;
  /** Balance AFTER the adjustment is applied. */
  newBalanceMinor: bigint;
  /** Balance BEFORE the adjustment (ledger audit trail). */
  priorBalanceMinor: bigint;
  createdAt: Date;
}

export async function applyAdminCreditAdjustment(args: {
  userId: string;
  currency: string;
  amountMinor: bigint;
  adminUserId: string;
  reason: string;
}): Promise<CreditAdjustment> {
  return db.transaction(async (tx) => {
    // Lock the (userId, currency) row FOR UPDATE so two concurrent
    // admin writes can't race the balance check. `SELECT ... FOR
    // UPDATE` returns null when the row doesn't exist yet — we
    // upsert below in that case.
    const [existing] = await tx
      .select()
      .from(userCredits)
      .where(and(eq(userCredits.userId, args.userId), eq(userCredits.currency, args.currency)))
      .for('update');

    const priorBalance = existing?.balanceMinor ?? 0n;
    const newBalance = priorBalance + args.amountMinor;

    if (newBalance < 0n) {
      throw new InsufficientBalanceError(args.currency, priorBalance, args.amountMinor);
    }

    const [row] = await tx
      .insert(creditTransactions)
      .values({
        userId: args.userId,
        type: 'adjustment',
        amountMinor: args.amountMinor,
        currency: args.currency,
        // (reference_type, reference_id) pins the adjustment to the
        // admin user who made it; `reason` carries the operator-
        // authored "why" (A2-908) so the full story stays on the
        // ledger row past the 24h idempotency-key TTL.
        referenceType: 'admin_adjustment',
        referenceId: args.adminUserId,
        reason: args.reason,
      })
      .returning();
    if (row === undefined) {
      // Drizzle shouldn't reach here — .returning() on a successful
      // insert always yields one row. Surfaced as a 500 upstream.
      throw new Error('credit_transactions insert returned no row');
    }

    if (existing === undefined) {
      await tx.insert(userCredits).values({
        userId: args.userId,
        currency: args.currency,
        balanceMinor: newBalance,
      });
    } else {
      await tx
        .update(userCredits)
        .set({ balanceMinor: newBalance, updatedAt: sql`NOW()` })
        .where(and(eq(userCredits.userId, args.userId), eq(userCredits.currency, args.currency)));
    }

    return {
      id: row.id,
      userId: args.userId,
      currency: args.currency,
      amountMinor: args.amountMinor,
      priorBalanceMinor: priorBalance,
      newBalanceMinor: newBalance,
      createdAt: row.createdAt,
    };
  });
}
