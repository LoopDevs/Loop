/**
 * Admin cashback-realization rate (ADR 009 / 015).
 *
 * `GET /api/admin/cashback-realization` — answers "of the cashback
 * Loop has emitted, what share is being recycled into new orders vs
 * sitting as outstanding liability?". The fleet flywheel-health KPI:
 * a high realization rate means users are spending their cashback
 * back on Loop rather than withdrawing or hoarding it.
 *
 * Aggregates `credit_transactions` by `currency`:
 *   - `earnedMinor`  = SUM(amount_minor) WHERE type='cashback'
 *   - `spentMinor`   = ABS(SUM(amount_minor)) WHERE type='spend'
 *   - `withdrawnMinor` = ABS(SUM(amount_minor)) WHERE type='withdrawal'
 *   - `outstandingMinor` = SUM(balance_minor) in user_credits
 *
 * `recycledPct` = spent / earned — what share of earned cashback
 * has been spent on new Loop orders (the flywheel dimension).
 *
 * A currency with zero earned cashback is omitted. GROUPING SETS
 * ((currency), ()) yields a fleet-wide row with `currency: null`.
 *
 * Numbers are authoritative from the ledger (Postgres) — no Horizon
 * dependency. Safe to serve from a single query.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { recycledBps } from '@loop/shared';
import { db } from '../db/client.js';
import { creditTransactions, userCredits } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-cashback-realization' });

export interface CashbackRealizationRow {
  /** ISO 4217 code; `null` for the fleet-wide aggregate row. */
  currency: string | null;
  /** Lifetime cashback earned. BigInt as string, minor units. */
  earnedMinor: string;
  /** Lifetime cashback spent on new Loop orders. BigInt as string, minor units. */
  spentMinor: string;
  /** Lifetime cashback withdrawn off-ledger. BigInt as string, minor units. */
  withdrawnMinor: string;
  /** Current outstanding liability (sum of user_credits.balance_minor). */
  outstandingMinor: string;
  /** 10000x recycledPct to preserve two decimals as integer bps. spent / earned. */
  recycledBps: number;
}

export interface CashbackRealizationResponse {
  rows: CashbackRealizationRow[];
}

interface LedgerAgg extends Record<string, unknown> {
  currency: string | null;
  earned: string | null;
  spent: string | null;
  withdrawn: string | null;
}

interface BalanceAgg extends Record<string, unknown> {
  currency: string | null;
  outstanding: string | null;
}

function toBigIntSafe(v: string | null): bigint {
  if (v === null) return 0n;
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
}

// `recycledBps` re-exported from @loop/shared so legacy imports
// (`from '../cashback-realization.js'`) keep resolving during any
// transition period.
export { recycledBps };

export async function adminCashbackRealizationHandler(c: Context): Promise<Response> {
  try {
    const ledgerResult = await db.execute<LedgerAgg>(sql`
      SELECT
        ${creditTransactions.currency} AS currency,
        COALESCE(
          SUM(CASE WHEN ${creditTransactions.type} = 'cashback' THEN ${creditTransactions.amountMinor} ELSE 0 END),
          0
        )::text AS earned,
        ABS(
          COALESCE(
            SUM(CASE WHEN ${creditTransactions.type} = 'spend' THEN ${creditTransactions.amountMinor} ELSE 0 END),
            0
          )
        )::text AS spent,
        ABS(
          COALESCE(
            SUM(CASE WHEN ${creditTransactions.type} = 'withdrawal' THEN ${creditTransactions.amountMinor} ELSE 0 END),
            0
          )
        )::text AS withdrawn
      FROM ${creditTransactions}
      GROUP BY GROUPING SETS ((${creditTransactions.currency}), ())
    `);
    const balanceResult = await db.execute<BalanceAgg>(sql`
      SELECT
        ${userCredits.currency} AS currency,
        COALESCE(SUM(${userCredits.balanceMinor}), 0)::text AS outstanding
      FROM ${userCredits}
      GROUP BY GROUPING SETS ((${userCredits.currency}), ())
    `);

    const ledgerRaw = (
      Array.isArray(ledgerResult)
        ? (ledgerResult as unknown as LedgerAgg[])
        : ((ledgerResult as unknown as { rows?: LedgerAgg[] }).rows ?? [])
    ) as LedgerAgg[];
    const balanceRaw = (
      Array.isArray(balanceResult)
        ? (balanceResult as unknown as BalanceAgg[])
        : ((balanceResult as unknown as { rows?: BalanceAgg[] }).rows ?? [])
    ) as BalanceAgg[];

    const balanceByCurrency = new Map<string | null, bigint>();
    for (const r of balanceRaw) {
      balanceByCurrency.set(r.currency, toBigIntSafe(r.outstanding));
    }

    const rows: CashbackRealizationRow[] = [];
    for (const r of ledgerRaw) {
      const earned = toBigIntSafe(r.earned);
      // Skip currencies that have never earned cashback unless
      // they're the fleet-wide aggregate row — the aggregate is
      // always included so the headline "X% realized" reads even
      // when all per-currency buckets are empty.
      if (earned === 0n && r.currency !== null) continue;
      const spent = toBigIntSafe(r.spent);
      rows.push({
        currency: r.currency,
        earnedMinor: earned.toString(),
        spentMinor: spent.toString(),
        withdrawnMinor: toBigIntSafe(r.withdrawn).toString(),
        outstandingMinor: (balanceByCurrency.get(r.currency) ?? 0n).toString(),
        recycledBps: recycledBps(earned, spent),
      });
    }
    // Order: fleet-wide (null) first, then per-currency alphabetically.
    rows.sort((a, b) => {
      if (a.currency === null) return -1;
      if (b.currency === null) return 1;
      return a.currency.localeCompare(b.currency);
    });

    const body: CashbackRealizationResponse = { rows };
    return c.json(body);
  } catch (err) {
    log.error({ err }, 'Cashback realization aggregation failed');
    return c.json(
      { code: 'INTERNAL_ERROR', message: 'Failed to compute cashback realization' },
      500,
    );
  }
}
