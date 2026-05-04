/**
 * Interest forward-mint forecast (ADR 009 / 015).
 *
 * Computes how much LOOP-asset the operator needs to mint into the
 * pool account to cover the next N days of interest accrual at the
 * current APY for the existing user-cohort balance.
 *
 * Intentionally a pure function over the current ledger state — no
 * forecast model for cohort growth, no churn assumptions. The
 * operator runs this monthly (say) and tops up the pool to the
 * computed amount. Cohort growth between mints is absorbed by:
 *
 *   1. The pool depletion alert (`interest-pool-watcher`) which
 *      pages when pool cover drops below a configurable floor.
 *   2. The drift watcher's pool-aware comparison — newly accrued
 *      interest that hasn't yet been pre-minted shows as drift,
 *      operator mints, drift recovers.
 *
 * The forecast assumes:
 *   - APY in basis points (`INTEREST_APY_BASIS_POINTS`)
 *   - 365 periods/year (daily accrual)
 *   - Compounding NOT modelled — a small under-estimate, but the
 *     compounding effect over a month at 4% APY is ~0.0003% of
 *     principal, well inside any operational rounding.
 */
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { userCredits } from '../db/schema.js';
import type { HomeCurrency, LoopAssetCode } from '@loop/shared';
import { loopAssetForCurrency, HOME_CURRENCIES } from '@loop/shared';

/**
 * Per-currency forecast row. All amounts in minor units (the
 * off-chain ledger's native unit) — caller multiplies by 1e5 to
 * cross to LOOP-asset stroops at mint-time.
 */
export interface InterestForecastEntry {
  currency: HomeCurrency;
  assetCode: LoopAssetCode;
  /** Sum of `user_credits.balance_minor` for this currency. */
  cohortBalanceMinor: bigint;
  /** Daily interest at the configured APY across the whole cohort. */
  dailyInterestMinor: bigint;
  /** `dailyInterestMinor × forecastDays`. */
  forecastDays: number;
  forecastInterestMinor: bigint;
}

export interface InterestForecast {
  apyBasisPoints: number;
  forecastDays: number;
  asOfMs: number;
  perCurrency: InterestForecastEntry[];
}

/**
 * Computes the per-day interest for a given cohort balance + APY,
 * matching `accrue-interest.ts:computeAccrualMinor` for `periodsPerYear=365`.
 * Floor division — the same direction the daily accrual itself rounds.
 */
function dailyInterestMinor(cohortBalanceMinor: bigint, apyBasisPoints: number): bigint {
  if (cohortBalanceMinor <= 0n) return 0n;
  if (apyBasisPoints <= 0) return 0n;
  return (cohortBalanceMinor * BigInt(apyBasisPoints)) / (10_000n * 365n);
}

/**
 * Returns the forward-mint forecast across all home currencies.
 * The caller decides which currencies to act on — typically the
 * operator only mints for currencies whose issuer is configured.
 *
 * `forecastDays` defaults to 35 (one month + a week of buffer) — a
 * common operator mint cadence is monthly, and 35 days gives the
 * operator a week to react to the depletion alert before the pool
 * actually runs dry.
 */
export async function computeInterestForecast(args: {
  apyBasisPoints: number;
  forecastDays?: number;
}): Promise<InterestForecast> {
  const forecastDays = args.forecastDays ?? 35;
  const now = Date.now();

  const rows = (await db
    .select({
      currency: userCredits.currency,
      total: sql<string>`COALESCE(SUM(${userCredits.balanceMinor}), 0)::text`,
    })
    .from(userCredits)
    .groupBy(userCredits.currency)) as Array<{ currency: string; total: string }>;

  const totals = new Map<HomeCurrency, bigint>();
  for (const r of rows) {
    if (HOME_CURRENCIES.includes(r.currency as HomeCurrency)) {
      totals.set(r.currency as HomeCurrency, BigInt(r.total));
    }
  }

  const perCurrency: InterestForecastEntry[] = HOME_CURRENCIES.map((currency) => {
    const cohortBalanceMinor = totals.get(currency) ?? 0n;
    const daily = dailyInterestMinor(cohortBalanceMinor, args.apyBasisPoints);
    return {
      currency,
      assetCode: loopAssetForCurrency(currency),
      cohortBalanceMinor,
      dailyInterestMinor: daily,
      forecastDays,
      forecastInterestMinor: daily * BigInt(forecastDays),
    };
  });

  return {
    apyBasisPoints: args.apyBasisPoints,
    forecastDays,
    asOfMs: now,
    perCurrency,
  };
}
