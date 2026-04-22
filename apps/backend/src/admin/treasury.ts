/**
 * Admin treasury view (ADR 009/011/015).
 *
 * Aggregates the credit ledger into a single read-optimised snapshot
 * the admin UI can render without running its own aggregation SQL:
 *
 *   - outstanding[currency] — sum of `user_credits.balance_minor`
 *     per currency: "how much does Loop owe users right now?".
 *   - totals[currency][type] — sum of `credit_transactions.amount_minor`
 *     grouped by (currency, type): "cashback credited all-time" vs
 *     "withdrawals paid" vs "interest accrued" etc.
 *   - liabilities — ADR 015 labelling of `outstanding` on the Stellar
 *     side: per LOOP asset code, the amount outstanding + the
 *     configured issuer account. The admin UI renders this as the
 *     "Loop liabilities" card so ops can tell at a glance how many
 *     USDLOOP/GBPLOOP/EURLOOP Loop is on the hook for.
 *   - assets — Loop's own holdings split off from the liabilities
 *     pile (ADR 015 treasury strategy). Initial MVP surface covers
 *     USDC and XLM holdings — live Stellar-side balances land in a
 *     follow-up slice, so these are nullable placeholders today.
 *   - operatorPool — snapshot of per-operator circuit state for the
 *     CTX supplier pool (ADR 013).
 *
 * All fields return as strings for `bigint`-backed columns so the
 * JSON envelope is safe across JS platforms (no silent precision
 * truncation into a `number`).
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  userCredits,
  creditTransactions,
  pendingPayouts,
  HOME_CURRENCIES,
  PAYOUT_STATES,
  type PayoutState,
} from '../db/schema.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { getOperatorHealth, operatorPoolSize } from '../ctx/operator-pool.js';
import { payoutAssetFor, type LoopAssetCode } from '../credits/payout-asset.js';
import { getAccountBalances } from '../payments/horizon-balances.js';

const log = logger.child({ handler: 'treasury' });

export interface LoopLiability {
  /** Outstanding claim in the matching fiat's minor units (pence, cents). */
  outstandingMinor: string;
  /** Stellar issuer account pinned by env; null when the operator hasn't configured this asset yet. */
  issuer: string | null;
}

export interface TreasuryHolding {
  /**
   * Live on-chain balance in stroops (7 decimals), or null when Loop
   * doesn't query that asset today. A future slice queries Horizon
   * for the operator account's USDC + XLM balances.
   */
  stroops: string | null;
}

export interface TreasurySnapshot {
  outstanding: Record<string, string>;
  totals: Record<string, Record<string, string>>;
  /** ADR 015 — per LOOP asset, outstanding + configured issuer. */
  liabilities: Record<LoopAssetCode, LoopLiability>;
  /** ADR 015 — Loop's yield-earning pile (USDC + XLM operator holdings). */
  assets: {
    USDC: TreasuryHolding;
    XLM: TreasuryHolding;
  };
  /**
   * ADR 015 — outbound Stellar cashback payouts at each state.
   * The admin UI renders this as a health card: any non-zero
   * `failed` count should page ops; a growing `submitted` count
   * without matching `confirmed` means the Horizon confirmation
   * watcher is lagging.
   */
  payouts: Record<PayoutState, string>;
  operatorPool: {
    size: number;
    /**
     * Per-operator snapshot. Richer than the list returned by the
     * getOperatorHealth() helper — the admin treasury view renders
     * "last OK 2m ago" / "last fail 14s ago" chips off these
     * timestamps (ADR 013 observability).
     */
    operators: Array<{
      id: string;
      state: string;
      consecutiveFailures: number;
      openedAt: number | null;
      lastSuccessAt: number | null;
      lastFailureAt: number | null;
    }>;
  };
}

/** GET /api/admin/treasury */
export async function treasuryHandler(c: Context): Promise<Response> {
  const outstandingRows = await db
    .select({
      currency: userCredits.currency,
      total: sql<string>`COALESCE(SUM(${userCredits.balanceMinor}), 0)::text`,
    })
    .from(userCredits)
    .groupBy(userCredits.currency);

  const totalsRows = await db
    .select({
      currency: creditTransactions.currency,
      type: creditTransactions.type,
      total: sql<string>`COALESCE(SUM(${creditTransactions.amountMinor}), 0)::text`,
    })
    .from(creditTransactions)
    .groupBy(creditTransactions.currency, creditTransactions.type);

  const outstanding: Record<string, string> = {};
  for (const row of outstandingRows) {
    outstanding[row.currency] = row.total;
  }

  const totals: Record<string, Record<string, string>> = {};
  for (const row of totalsRows) {
    let bucket = totals[row.currency];
    if (bucket === undefined) {
      bucket = {};
      totals[row.currency] = bucket;
    }
    bucket[row.type] = row.total;
  }

  const liabilities = buildLiabilities(outstanding);
  const assets = await buildAssets();
  const payouts = await buildPayoutCounts();

  const snapshot: TreasurySnapshot = {
    outstanding,
    totals,
    liabilities,
    assets,
    payouts,
    operatorPool: {
      size: operatorPoolSize(),
      operators: getOperatorHealth(),
    },
  };

  return c.json(snapshot);
}

/**
 * Groups pending_payouts rows by state. Always returns entries for
 * every state (zero when no rows match) so the UI shape is stable —
 * a fresh install should render "0 pending / 0 submitted / 0
 * confirmed / 0 failed", not an empty object.
 */
async function buildPayoutCounts(): Promise<Record<PayoutState, string>> {
  const rows = await db
    .select({
      state: pendingPayouts.state,
      count: sql<string>`COUNT(*)::text`,
    })
    .from(pendingPayouts)
    .groupBy(pendingPayouts.state);
  const out = {} as Record<PayoutState, string>;
  for (const s of PAYOUT_STATES) {
    out[s] = '0';
  }
  for (const row of rows) {
    if ((PAYOUT_STATES as ReadonlyArray<string>).includes(row.state)) {
      out[row.state as PayoutState] = row.count;
    }
  }
  return out;
}

/**
 * Reads the live USDC + XLM balances on Loop's operator account
 * (currently the same as `LOOP_STELLAR_DEPOSIT_ADDRESS`). A Horizon
 * failure does NOT 500 the treasury handler — this surface is the
 * admin's primary view into financial state, and we'd rather render
 * "—" next to a best-effort stale everything-else than lose the
 * whole page to a transient upstream blip. The 30s cache in
 * getAccountBalances already handles the hot path.
 *
 * When `LOOP_STELLAR_DEPOSIT_ADDRESS` is unset, we return null stroops
 * — a dev / pre-deploy environment with no Stellar wiring shouldn't
 * show misleading zeros to the operator.
 */
async function buildAssets(): Promise<TreasurySnapshot['assets']> {
  const account = env.LOOP_STELLAR_DEPOSIT_ADDRESS;
  if (account === undefined) {
    return { USDC: { stroops: null }, XLM: { stroops: null } };
  }
  try {
    const snap = await getAccountBalances(account, env.LOOP_STELLAR_USDC_ISSUER ?? null);
    return {
      USDC: { stroops: snap.usdcStroops?.toString() ?? null },
      XLM: { stroops: snap.xlmStroops?.toString() ?? null },
    };
  } catch (err) {
    log.warn({ err, account }, 'Horizon balance read failed — treasury assets unavailable');
    return { USDC: { stroops: null }, XLM: { stroops: null } };
  }
}

/**
 * Re-frames `outstanding` as LOOP-asset liabilities: the currency
 * key is swapped for the matching LOOP asset code, and the issuer
 * is pinned alongside so the admin UI can flag "no issuer
 * configured" next to the number. Always returns entries for all
 * three assets so the UI shape is stable across deploys.
 */
function buildLiabilities(
  outstanding: Record<string, string>,
): Record<LoopAssetCode, LoopLiability> {
  // Keys are typed narrowly; the cast is safe because we construct
  // the whole record inside the same loop.
  const out = {} as Record<LoopAssetCode, LoopLiability>;
  for (const currency of HOME_CURRENCIES) {
    const { code, issuer } = payoutAssetFor(currency);
    out[code] = {
      outstandingMinor: outstanding[currency] ?? '0',
      issuer,
    };
  }
  return out;
}
