/**
 * Admin supplier-spend snapshot (ADR 013 / 015).
 *
 * `GET /api/admin/supplier-spend` — per-currency aggregate of what
 * Loop has paid CTX (the gift-card supplier) across fulfilled orders
 * in a rolling window.
 *
 * A2-904: rows are keyed on `orders.charge_currency` — the user's
 * home currency at order creation — because `orders/repo.ts`
 * computes `wholesale_minor` from `chargeMinor` at the pinned FX
 * rate, so the ledger-side wholesale number is in home-currency
 * terms. An earlier version of this handler grouped by
 * `orders.currency` (the gift card's catalog currency), which
 * silently mixed GBP pence + USD cents whenever a user bought a
 * cross-region gift card — the resulting USD bucket summed
 * different-currency rows and labelled the total as USD. The
 * `face_value_minor` sum remains slightly currency-mixed within a
 * single charge_currency bucket (face_value is catalog currency and
 * a GBP user can buy a USD card), but that field is "gift cards
 * shipped to users" — a headline metric, not a ledger-reconcile
 * number — and the mix is ≤1% of orders in Phase 1.
 *
 * For each currency the snapshot surfaces:
 *   - count           — fulfilled orders in the window
 *   - faceValueMinor  — gift card face value Loop ships to users
 *   - wholesaleMinor  — what CTX billed Loop (supplier cost)
 *   - userCashbackMinor — cashback Loop owes / paid the users
 *   - loopMarginMinor — net kept by Loop after cashback + supplier
 *
 * This is the "CTX-as-supplier" counterpart to `/api/admin/treasury`,
 * which only sees the on-chain liability side. Ops uses this to
 * reconcile monthly invoices against CTX and to spot per-currency
 * margin drift (e.g. GBP cards turn unprofitable while USD holds).
 *
 * Window: `?since=<iso-8601>` (default 24h ago). No upper bound — the
 * admin UI can walk back day-by-day by re-requesting with an earlier
 * `since`. bigint-as-string on the wire.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-supplier-spend' });

export interface SupplierSpendRow {
  currency: string;
  count: number;
  faceValueMinor: string;
  wholesaleMinor: string;
  userCashbackMinor: string;
  loopMarginMinor: string;
  /**
   * Loop margin as basis points of face value (loopMargin / face ×
   * 10 000). Integer, clamped [0, 10 000]. 0 when a row has zero
   * face value (shouldn't happen given the CHECK constraints, but
   * division-by-zero defence is cheap).
   */
  marginBps: number;
}

export interface SupplierSpendResponse {
  since: string;
  rows: SupplierSpendRow[];
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

interface AggRow {
  currency: string;
  count: string | number;
  face_value_minor: string | number;
  wholesale_minor: string | number;
  user_cashback_minor: string | number;
  loop_margin_minor: string | number;
}

function toStringBigint(value: string | number | bigint): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Math.trunc(value).toString();
  return value;
}

/**
 * loopMargin / faceValue × 10 000 as integer bps, clamped to
 * [0, 10 000]. Matches the `recycledBps` contract in @loop/shared
 * (same rounding direction, same clamp). Kept local for now — a
 * second consumer would earn a lift to @loop/shared.
 */
export function marginBps(faceValueMinor: bigint, loopMarginMinor: bigint): number {
  if (faceValueMinor <= 0n) return 0;
  const clamped = loopMarginMinor < 0n ? 0n : loopMarginMinor;
  const scaled = (clamped * 10_000n) / faceValueMinor;
  const n = Number(scaled);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > 10_000 ? 10_000 : n;
}

function toBigIntSafe(value: string | number | bigint): bigint {
  if (typeof value === 'bigint') return value;
  try {
    return BigInt(typeof value === 'number' ? Math.trunc(value) : value);
  } catch {
    return 0n;
  }
}

export async function adminSupplierSpendHandler(c: Context): Promise<Response> {
  const sinceRaw = c.req.query('since');
  let since: Date;
  if (sinceRaw !== undefined && sinceRaw.length > 0) {
    const d = new Date(sinceRaw);
    if (Number.isNaN(d.getTime())) {
      return c.json(
        { code: 'VALIDATION_ERROR', message: 'since must be an ISO-8601 timestamp' },
        400,
      );
    }
    since = d;
  } else {
    since = new Date(Date.now() - DEFAULT_WINDOW_MS);
  }

  // Cap the window to 1 year — a pg aggregate over the full fulfilled
  // history would scan the whole orders table with no covering index,
  // which is a foot-gun for whoever leaves this endpoint open in a
  // browser tab.
  const windowMs = Date.now() - since.getTime();
  if (windowMs > MAX_WINDOW_MS) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'since cannot be more than 366 days ago' },
      400,
    );
  }

  try {
    // A2-904: GROUP BY charge_currency (not catalog `currency`) so
    // SUM(wholesale_minor / user_cashback_minor / loop_margin_minor)
    // aggregates values that are actually in the same currency. The
    // response field is still named `currency` for wire-compat but
    // means "the currency the aggregated sums are denominated in",
    // i.e. user home currency.
    const result = await db.execute(sql`
      SELECT
        ${orders.chargeCurrency} AS currency,
        COUNT(*)::bigint AS count,
        COALESCE(SUM(${orders.faceValueMinor}), 0)::bigint AS face_value_minor,
        COALESCE(SUM(${orders.wholesaleMinor}), 0)::bigint AS wholesale_minor,
        COALESCE(SUM(${orders.userCashbackMinor}), 0)::bigint AS user_cashback_minor,
        COALESCE(SUM(${orders.loopMarginMinor}), 0)::bigint AS loop_margin_minor
      FROM ${orders}
      WHERE ${orders.state} = 'fulfilled'
        AND ${orders.fulfilledAt} IS NOT NULL
        AND ${orders.fulfilledAt} >= ${since}
      GROUP BY ${orders.chargeCurrency}
      ORDER BY ${orders.chargeCurrency} ASC
    `);

    const raw = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const rows: SupplierSpendRow[] = raw.map((r) => {
      const face = toBigIntSafe(r.face_value_minor);
      const margin = toBigIntSafe(r.loop_margin_minor);
      return {
        currency: r.currency,
        count: Number(r.count),
        faceValueMinor: face.toString(),
        wholesaleMinor: toStringBigint(r.wholesale_minor),
        userCashbackMinor: toStringBigint(r.user_cashback_minor),
        loopMarginMinor: margin.toString(),
        marginBps: marginBps(face, margin),
      };
    });

    const body: SupplierSpendResponse = { since: since.toISOString(), rows };
    return c.json(body);
  } catch (err) {
    log.error({ err }, 'Supplier-spend aggregate failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to compute supplier spend' }, 500);
  }
}
