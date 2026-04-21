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
 */
import { eq, gt } from 'drizzle-orm';
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
  /** Sum of all credited amounts, keyed by currency. BigInt minor units. */
  totalsMinor: Record<string, bigint>;
}

/**
 * Accrues one period of interest against every user_credits row with
 * a positive balance. Returns counts + per-currency totals so the
 * caller can log a single batch summary.
 *
 * Idempotency: this function is NOT idempotent on its own — running
 * it twice in the same period double-credits. Scheduling is expected
 * to drive it exactly once per period (the follow-up scheduling slice
 * keys the last-run timestamp on a `watcher_cursors` row; a replayed
 * tick inside the same period is a no-op there).
 */
export async function accrueOnePeriod(period: AccrualPeriod): Promise<AccrualResult> {
  if (period.apyBasisPoints <= 0) {
    return { users: 0, credited: 0, skippedZero: 0, totalsMinor: {} };
  }

  // Read all non-zero balances. user_credits has one row per
  // (user_id, currency); a user with no credits has no row at all,
  // and `balance_minor > 0` is a CHECK-enforced invariant we further
  // narrow here for clarity.
  const rows = await db
    .select({
      userId: userCredits.userId,
      currency: userCredits.currency,
      balanceMinor: userCredits.balanceMinor,
    })
    .from(userCredits)
    .where(gt(userCredits.balanceMinor, 0n));

  const result: AccrualResult = {
    users: rows.length,
    credited: 0,
    skippedZero: 0,
    totalsMinor: {},
  };

  for (const row of rows) {
    const accrual = computeAccrualMinor(row.balanceMinor, period);
    if (accrual <= 0n) {
      result.skippedZero++;
      continue;
    }
    try {
      await db.transaction(async (tx) => {
        await tx.insert(creditTransactions).values({
          userId: row.userId,
          type: 'interest',
          amountMinor: accrual,
          currency: row.currency,
          referenceType: null,
          referenceId: null,
        });
        await tx
          .update(userCredits)
          .set({
            balanceMinor: row.balanceMinor + accrual,
          })
          .where(eq(userCredits.userId, row.userId));
      });
      result.credited++;
      const prev = result.totalsMinor[row.currency];
      result.totalsMinor[row.currency] = (prev ?? 0n) + accrual;
    } catch (err) {
      log.error(
        { err, userId: row.userId, currency: row.currency },
        'Interest accrual txn failed for user',
      );
    }
  }

  return result;
}
