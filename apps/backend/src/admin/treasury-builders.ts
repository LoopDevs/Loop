/**
 * Treasury-snapshot section builders (ADR 009 / 011 / 015).
 *
 * Lifted out of `apps/backend/src/admin/treasury.ts` so the four
 * read-side aggregators that compose the snapshot live in their
 * own focused module separate from the handler that wires them
 * together:
 *
 *   - `buildPayoutCounts()` — pending_payouts grouped by state,
 *     zero-filled across PAYOUT_STATES so a fresh install renders
 *     a stable shape.
 *   - `buildOrderFlows()` — fulfilled-order economics aggregated
 *     by charge currency (ADR 015 — face / wholesale / cashback /
 *     margin breakdown).
 *   - `buildAssets()` — Loop's own USDC + XLM holdings via
 *     `getAccountBalances`. Horizon failures fall back to
 *     null-stroops so a transient blip doesn't 500 the whole
 *     treasury surface.
 *   - `buildLiabilities(outstanding)` — re-keys the credit-ledger
 *     `outstanding` map into LOOP-asset codes + issuer pin.
 *
 * Re-exported from `treasury.ts` is unnecessary — these are
 * implementation details of the handler. The handler imports
 * them directly from this module.
 */
import { eq, sql } from 'drizzle-orm';
import type { LoopLiability, TreasuryOrderFlow, TreasurySnapshot } from '@loop/shared';
import { db } from '../db/client.js';
import {
  pendingPayouts,
  orders,
  HOME_CURRENCIES,
  PAYOUT_STATES,
  type PayoutState,
} from '../db/schema.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { payoutAssetFor, type LoopAssetCode } from '../credits/payout-asset.js';
import { getAccountBalances } from '../payments/horizon-balances.js';

const log = logger.child({ handler: 'treasury' });

/**
 * Groups pending_payouts rows by state. Always returns entries for
 * every state (zero when no rows match) so the UI shape is stable —
 * a fresh install should render "0 pending / 0 submitted / 0
 * confirmed / 0 failed", not an empty object.
 */
export async function buildPayoutCounts(): Promise<Record<PayoutState, string>> {
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
 * Aggregates fulfilled-order economics by charge currency (ADR 015).
 * Each row sums the four pinned minor-unit columns (`face_value`,
 * `wholesale`, `user_cashback`, `loop_margin`) plus a row count —
 * letting the admin UI render the CTX-as-supplier P&L without the
 * client re-running the math.
 *
 * Pending / failed / expired orders are excluded: an order hasn't
 * "flowed" until it lands fulfilled (CTX procured, user holds a
 * redeemable card). Refunds would show up as negative-sign entries
 * in the credits ledger, not here.
 */
export async function buildOrderFlows(): Promise<Record<string, TreasuryOrderFlow>> {
  const rows = await db
    .select({
      currency: orders.chargeCurrency,
      count: sql<string>`COUNT(*)::text`,
      faceValue: sql<string>`COALESCE(SUM(${orders.faceValueMinor}), 0)::text`,
      wholesale: sql<string>`COALESCE(SUM(${orders.wholesaleMinor}), 0)::text`,
      userCashback: sql<string>`COALESCE(SUM(${orders.userCashbackMinor}), 0)::text`,
      loopMargin: sql<string>`COALESCE(SUM(${orders.loopMarginMinor}), 0)::text`,
    })
    .from(orders)
    .where(eq(orders.state, 'fulfilled'))
    .groupBy(orders.chargeCurrency);
  const out: Record<string, TreasuryOrderFlow> = {};
  for (const row of rows) {
    out[row.currency] = {
      count: row.count,
      faceValueMinor: row.faceValue,
      wholesaleMinor: row.wholesale,
      userCashbackMinor: row.userCashback,
      loopMarginMinor: row.loopMargin,
    };
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
export async function buildAssets(): Promise<TreasurySnapshot['assets']> {
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
export function buildLiabilities(
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
