/**
 * Interest accrual on Loop credit balances (ADR 009).
 *
 * Credits users with a share of the configured APY every tick.
 * Integer-only BigInt math: given an APY expressed in basis points
 * (400 bps = 4.00%) and a period fraction (e.g. 1/12 for monthly,
 * 1/365 for daily), the per-period rate is
 *
 *     interest = balance × apy_bps / (10_000 × periodsPerYear)
 *
 * Flooring rounds toward zero, so Loop never overpays by a fraction
 * of a minor unit — the same direction every other ledger write
 * errs in (ADR 010 order pinning leaves rounding residual with
 * Loop).
 *
 * Every non-zero accrual writes a `credit_transactions(type=interest)`
 * row + bumps `user_credits.balance_minor` inside one transaction so
 * balance and ledger always agree. Zero accruals (tiny balance,
 * zero APY) skip both — type='interest' has a CHECK amount>0.
 *
 * Correctness properties (audit remediation, 2026-04-23 — closes
 * A2-610 / A2-611 / A2-700 / A2-906):
 *
 * - **Currency-scoped UPDATE** — the balance update is keyed by
 *   `(user_id, currency)`. A multi-currency user's other-currency
 *   rows are left untouched. (The prior bug: UPDATE filtered only
 *   by `user_id`, so every currency row got the same single-currency
 *   balance written back.)
 *
 * - **SELECT ... FOR UPDATE inside the txn** — the balance read
 *   and the subsequent write happen against a row locked for the
 *   duration of the transaction. A concurrent
 *   `applyAdminCreditAdjustment` waits for the lock and then reads
 *   the post-accrual balance; neither write is lost.
 *
 * - **Period-level idempotency** — the caller supplies a
 *   `periodCursor` string (e.g. `"2026-04-23"` for daily accrual).
 *   The `credit_transactions` table has a partial unique index on
 *   `(user_id, currency, period_cursor) WHERE type='interest'` — a
 *   re-tick with the same cursor raises a unique-violation at the
 *   DB layer rather than silently double-crediting. We catch the
 *   violation per row and skip, so a retry of a partially-completed
 *   run makes progress on the remaining users instead of bailing.
 */
import { and, eq, gt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditTransactions, userCredits } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ area: 'interest-accrual' });

export interface AccrualPeriod {
  /** Annual rate as integer basis points. 400 = 4.00% APY. */
  apyBasisPoints: number;
  /** Periods in a year (1/fraction). Monthly = 12, daily = 365. */
  periodsPerYear: number;
}

/** Basis-point / periods math. Exported for direct test coverage. */
export function computeAccrualMinor(balanceMinor: bigint, period: AccrualPeriod): bigint {
  if (balanceMinor <= 0n) return 0n;
  if (period.apyBasisPoints <= 0 || period.periodsPerYear <= 0) return 0n;
  const bps = BigInt(period.apyBasisPoints);
  const perYear = BigInt(period.periodsPerYear);
  return (balanceMinor * bps) / (10_000n * perYear);
}

export interface AccrualResult {
  users: number;
  credited: number;
  skippedZero: number;
  /**
   * Users skipped because this `periodCursor` had already accrued
   * for them (unique-index violation caught). Non-zero means the
   * run is a partial retry of a prior tick — expected, not an error.
   */
  skippedAlreadyAccrued: number;
  /** Sum of all credited amounts, keyed by currency. BigInt minor units. */
  totalsMinor: Record<string, bigint>;
}

/**
 * Accrues one period of interest against every `user_credits` row
 * with a positive balance. Returns counts + per-currency totals so
 * the caller can log a single batch summary.
 *
 * `periodCursor` uniquely identifies this period. Two calls with
 * the same cursor are a no-op for already-accrued (user, currency)
 * pairs. The cursor is stored on every inserted row so a human
 * auditing the ledger can see which tick credited them.
 */
export async function accrueOnePeriod(
  period: AccrualPeriod,
  periodCursor: string,
): Promise<AccrualResult> {
  if (period.apyBasisPoints <= 0) {
    return {
      users: 0,
      credited: 0,
      skippedZero: 0,
      skippedAlreadyAccrued: 0,
      totalsMinor: {},
    };
  }
  if (periodCursor.length === 0) {
    throw new Error('accrueOnePeriod: periodCursor must be a non-empty string');
  }

  // Read all non-zero balances. user_credits has one row per
  // (user_id, currency); a user with no credits has no row at all,
  // and `balance_minor > 0` is a CHECK-enforced invariant we further
  // narrow here for clarity. The read here is the *planning* list —
  // each user's actual balance is re-read inside its own txn under
  // a FOR UPDATE lock so the write is against a fresh value.
  const plan = await db
    .select({
      userId: userCredits.userId,
      currency: userCredits.currency,
    })
    .from(userCredits)
    .where(gt(userCredits.balanceMinor, 0n));

  const result: AccrualResult = {
    users: plan.length,
    credited: 0,
    skippedZero: 0,
    skippedAlreadyAccrued: 0,
    totalsMinor: {},
  };

  for (const target of plan) {
    try {
      const applied = await db.transaction(async (tx) => {
        // Re-read the balance under a FOR UPDATE row lock. Concurrent
        // writers to the same (user, currency) row — admin
        // adjustments, cashback capture, a racing accrual — wait
        // here and see the post-accrual balance.
        const fresh = await tx
          .select({ balanceMinor: userCredits.balanceMinor })
          .from(userCredits)
          .where(
            and(eq(userCredits.userId, target.userId), eq(userCredits.currency, target.currency)),
          )
          .for('update');

        const balance = fresh[0]?.balanceMinor;
        if (balance === undefined || balance <= 0n) {
          return { status: 'skipped-zero' as const };
        }

        const accrual = computeAccrualMinor(balance, period);
        if (accrual <= 0n) {
          return { status: 'skipped-zero' as const };
        }

        await tx.insert(creditTransactions).values({
          userId: target.userId,
          type: 'interest',
          amountMinor: accrual,
          currency: target.currency,
          referenceType: null,
          referenceId: null,
          periodCursor,
        });

        await tx
          .update(userCredits)
          .set({ balanceMinor: balance + accrual })
          .where(
            and(eq(userCredits.userId, target.userId), eq(userCredits.currency, target.currency)),
          );

        return { status: 'credited' as const, accrual };
      });

      if (applied.status === 'credited') {
        result.credited++;
        const prev = result.totalsMinor[target.currency];
        result.totalsMinor[target.currency] = (prev ?? 0n) + applied.accrual;
      } else {
        result.skippedZero++;
      }
    } catch (err) {
      // Unique-violation on the partial index = this (user, currency,
      // periodCursor) already accrued. That's the idempotency
      // guarantee firing — skip the row and keep going so a retried
      // run of a partially-completed tick still makes progress on
      // users that never accrued.
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes('credit_transactions_interest_period_unique') ||
        message.includes('duplicate key value violates unique constraint')
      ) {
        result.skippedAlreadyAccrued++;
        continue;
      }
      log.error(
        { err, userId: target.userId, currency: target.currency, periodCursor },
        'Interest accrual txn failed for user',
      );
    }
  }

  // Surface a single batch summary when the run was meaningfully
  // noisy — either because some users were skipped due to prior
  // accrual (retry of a partial tick) or because no balances ticked
  // (quiet period).
  if (result.skippedAlreadyAccrued > 0) {
    log.info(
      {
        periodCursor,
        credited: result.credited,
        skippedAlreadyAccrued: result.skippedAlreadyAccrued,
      },
      'Interest accrual partial-retry skipped already-accrued rows',
    );
  }

  return result;
}
