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
 * The handler still does an early read for user-friendly 404 / asset
 * derivation, but this primitive now re-checks the ADR-024 §5
 * preconditions under `SELECT ... FOR UPDATE` so a stale handler read
 * cannot race an admin retry into a double-benefit path.
 *
 * Scope deliberately excludes auto-detection of permanent-vs-
 * retryable failure. Manual review by finance is the Phase 2a
 * workflow per ADR-024 §5.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditTransactions, pendingPayouts, userCredits } from '../db/schema.js';
import { env } from '../env.js';
import { DailyAdjustmentLimitError } from './adjustments.js';

export class PayoutNotCompensableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayoutNotCompensableError';
  }
}

export class AlreadyCompensatedError extends Error {
  constructor(public readonly payoutId: string) {
    super(`Payout ${payoutId} has already been compensated`);
    this.name = 'AlreadyCompensatedError';
  }
}

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
 * Preconditions (re-checked under row lock here):
 *   - `payoutId` exists, has `kind='withdrawal'`, `state='failed'`,
 *     and `compensated_at IS NULL`.
 *   - `amountMinor` matches the original withdrawal magnitude (the
 *     handler converts stroops → minor with the same `/100_000n`
 *     factor `applyAdminWithdrawal` used in reverse).
 *
 * The function also enforces the schema-side guard (`amountMinor > 0`).
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
    const [payout] = await tx
      .select()
      .from(pendingPayouts)
      .where(eq(pendingPayouts.id, args.payoutId))
      .for('update');
    if (payout === undefined) {
      throw new PayoutNotCompensableError('Payout not found');
    }
    if (payout.kind !== 'withdrawal') {
      throw new PayoutNotCompensableError(
        'Compensation only applies to withdrawal payouts; order-cashback failures use a different flow',
      );
    }
    if (payout.compensatedAt !== null) {
      throw new AlreadyCompensatedError(args.payoutId);
    }
    if (payout.state !== 'failed') {
      throw new PayoutNotCompensableError(
        `Payout is in state '${payout.state}'; only 'failed' payouts can be compensated`,
      );
    }

    // A4-022: cross-check the locked payout's `userId` and the
    // requesting user. A misuse from a future internal caller
    // (cron / retry / a wrong-arg admin handler bug) that compensates
    // user B for user A's failed payout would silently credit the
    // wrong account. The lock above is `id`-scoped so we have the
    // canonical row in hand; assert it.
    if (payout.userId !== args.userId) {
      throw new PayoutNotCompensableError(
        `Payout userId '${payout.userId}' does not match args.userId '${args.userId}'`,
      );
    }

    // A4-021: verify `amountMinor` equals the payout's outstanding
    // stroops, divided by the LOOP-asset 100_000 stroops/minor
    // ratio. The handler computes this correctly today, but the
    // primitive should not trust the caller; over-compensation
    // would silently inflate the user's balance vs. what was
    // actually owed.
    const expectedAmountMinor = payout.amountStroops / 100_000n;
    if (args.amountMinor !== expectedAmountMinor) {
      throw new PayoutNotCompensableError(
        `Compensation amount '${args.amountMinor}' does not match payout outstanding '${expectedAmountMinor}' (stroops=${payout.amountStroops})`,
      );
    }

    // A4-020: enforce the same daily admin-write cap on compensation
    // rows that `applyAdminCreditAdjustment` enforces on adjustment
    // rows. Earlier the cap query filtered on
    // `referenceType='admin_adjustment'`, so compensation rows
    // (`referenceType='payout'`) bypassed entirely — a compromised
    // admin token could drain the treasury through compensation
    // beyond the per-day cap. Apply the same cap to compensation
    // totals (per currency, per day, all admins combined) until a
    // schema-level per-admin attribution lands.
    const capMinor = env.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR;
    if (capMinor > 0n) {
      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      const [dayRow] = await tx
        .select({
          usedMinor: sql<string>`COALESCE(SUM(ABS(${creditTransactions.amountMinor}))::text, '0')`,
        })
        .from(creditTransactions)
        .where(
          and(
            eq(creditTransactions.type, 'adjustment'),
            eq(creditTransactions.referenceType, 'payout'),
            eq(creditTransactions.currency, args.currency),
            gte(creditTransactions.createdAt, dayStart),
          ),
        );
      const used = BigInt(dayRow?.usedMinor ?? '0');
      const attempt = args.amountMinor;
      if (used + attempt > capMinor) {
        throw new DailyAdjustmentLimitError(args.currency, dayStart, used, capMinor, attempt);
      }
    }

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

    await tx
      .update(pendingPayouts)
      .set({ compensatedAt: sql`NOW()` })
      .where(eq(pendingPayouts.id, args.payoutId));

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
