/**
 * Admin payout-compensation writer (ADR-024 §5).
 *
 * When a queued withdrawal's on-chain payout permanently fails (the
 * destination account doesn't exist, the operator lacks a trustline,
 * Horizon returns a non-retryable `op_*` error), the user's ledger is
 * net-negative — the original `applyAdminWithdrawal` debit landed but
 * the matching Stellar payment never settled. This module re-credits
 * the user's off-chain balance so the withdrawal becomes a no-op end-
 * to-end.
 *
 * Per ADR-024 §5, the compensation row is a `type='adjustment'`, NOT
 * a `type='refund'`:
 *
 *   - `refund` is scoped to orders by the partial unique index on
 *     `(type='refund', reference_type='order', reference_id)`. A
 *     payout-compensation row references a `payout`, not an order, so
 *     the index would not catch a duplicate.
 *   - `adjustment` is excluded from the partial unique index entirely
 *     (idempotency handled at the API boundary by the admin
 *     idempotency-key store, ADR-017).
 *
 * The handler that wraps this primitive enforces the ADR-024 §5
 * preconditions: the payout must be `kind='withdrawal'` and
 * `state='failed'`. We do not re-derive those here because the credit-
 * layer primitive should not couple to the on-chain payout state
 * machine; the handler is the integration point.
 *
 * Scope deliberately excludes:
 *   - Marking the payout as compensated. Phase 2a leaves the row
 *     `state='failed'` so the same payout can't be silently double-
 *     compensated by an operator forgetting they already filed; the
 *     ADR-017 idempotency snapshot is the at-most-once gate.
 *   - Auto-detection of permanent-vs-retryable failure. Manual review
 *     by finance is the Phase 2a workflow per ADR-024 §5.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditTransactions, userCredits } from '../db/schema.js';

export interface PayoutCompensationResult {
  /** credit_transactions.id of the compensation row. */
  id: string;
  /** Echoed pending_payouts.id the compensation references. */
  payoutId: string;
  userId: string;
  currency: string;
  /** Unsigned magnitude — the stored adjustment row is positive. */
  amountMinor: bigint;
  /** Balance BEFORE the compensation lands. */
  priorBalanceMinor: bigint;
  /** Balance AFTER the compensation. */
  newBalanceMinor: bigint;
  createdAt: Date;
}

/**
 * Apply an admin-triggered payout compensation: insert a positive
 * `type='adjustment'` row referencing the failed payout and bump the
 * user's `user_credits` balance by the same magnitude.
 *
 * Preconditions (caller-enforced):
 *   - `payoutId` exists, has `kind='withdrawal'`, and `state='failed'`.
 *   - `amountMinor` matches the original withdrawal magnitude (the
 *     handler converts stroops → minor with the same `/100_000n`
 *     factor `applyAdminWithdrawal` used in reverse).
 *
 * The function itself only enforces the schema-side guard
 * (`amountMinor > 0`); the handler is the integration point that
 * loads + checks the payout row.
 */
export async function applyAdminPayoutCompensation(args: {
  userId: string;
  currency: string;
  amountMinor: bigint;
  payoutId: string;
  reason: string;
}): Promise<PayoutCompensationResult> {
  if (args.amountMinor <= 0n) {
    throw new Error('Compensation amount must be positive');
  }

  return await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(userCredits)
      .where(and(eq(userCredits.userId, args.userId), eq(userCredits.currency, args.currency)))
      .for('update');

    const priorBalance = existing?.balanceMinor ?? 0n;

    const [creditTx] = await tx
      .insert(creditTransactions)
      .values({
        userId: args.userId,
        type: 'adjustment',
        amountMinor: args.amountMinor,
        currency: args.currency,
        referenceType: 'payout',
        referenceId: args.payoutId,
        reason: args.reason,
      })
      .returning();
    if (creditTx === undefined) {
      throw new Error('credit_transactions insert returned no row');
    }

    const newBalance = priorBalance + args.amountMinor;
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
      id: creditTx.id,
      payoutId: args.payoutId,
      userId: args.userId,
      currency: args.currency,
      amountMinor: args.amountMinor,
      priorBalanceMinor: priorBalance,
      newBalanceMinor: newBalance,
      createdAt: creditTx.createdAt,
    };
  });
}
