/**
 * Admin per-merchant cashback stats (ADR 011 / 015).
 *
 * `GET /api/admin/merchant-stats` — per-merchant aggregate across
 * fulfilled orders in a window. Distinct from
 * `/api/admin/supplier-spend` (#464), which groups by currency —
 * this one groups by merchant so ops can see:
 *   - which merchants drive the most volume (orderCount)
 *   - which merchants drive the most cashback outlay (userCashbackMinor)
 *   - which merchants deliver the best margin (loopMarginMinor)
 *
 * Directly feeds the "which merchants to prioritise with CTX for
 * better wholesale rates" decision.
 *
 * Window: `?since=<iso>` (default 31 days ago), max 366 days.
 * Sorted by `userCashbackMinor` descending — highest-cashback
 * merchants surface first because those are the rows ops cares
 * about. bigint-as-string on the wire for every `*_minor`.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-merchant-stats' });

const DEFAULT_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

export interface MerchantStatsRow {
  merchantId: string;
  orderCount: number;
  /**
   * Distinct users who earned cashback from this merchant in the
   * window. A cohort-health signal ops reads alongside `orderCount` —
   * "100 orders from 3 power users" vs "100 orders from 80 distinct
   * users" describe very different merchant profiles.
   */
  uniqueUserCount: number;
  faceValueMinor: string;
  wholesaleMinor: string;
  userCashbackMinor: string;
  loopMarginMinor: string;
  /**
   * Most-recent fulfilled order for this merchant in the window. ISO-8601.
   * Useful signal for "merchant with strong history but no recent volume".
   */
  lastFulfilledAt: string;
  /** Dominant catalog currency. Most merchants only have one; the aggregate
   * picks the most-fulfilled currency in the window when there are multiple. */
  currency: string;
}

export interface MerchantStatsResponse {
  since: string;
  rows: MerchantStatsRow[];
}

interface AggRow {
  merchant_id: string;
  currency: string;
  order_count: string | number;
  unique_user_count: string | number;
  face_value_minor: string | number | bigint;
  wholesale_minor: string | number | bigint;
  user_cashback_minor: string | number | bigint;
  loop_margin_minor: string | number | bigint;
  last_fulfilled_at: Date | string;
}

function toNumber(value: string | number): number {
  if (typeof value === 'number') return value;
  return Number.parseInt(value, 10);
}
function toStringBigint(value: string | number | bigint): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Math.trunc(value).toString();
  return value;
}
function toIso(value: Date | string): string {
  if (typeof value === 'string') {
    // pg drivers sometimes return a string; coerce to a Date and
    // re-serialise so the wire format is predictable.
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return value;
  }
  return value.toISOString();
}

export async function adminMerchantStatsHandler(c: Context): Promise<Response> {
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
  if (Date.now() - since.getTime() > MAX_WINDOW_MS) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'since cannot be more than 366 days ago' },
      400,
    );
  }

  try {
    // One row per (merchant, currency) in the window. Most merchants
    // have a single catalog currency, but the GROUP-BY handles the
    // multi-currency edge case safely.
    const result = await db.execute(sql`
      SELECT
        ${orders.merchantId} AS merchant_id,
        ${orders.currency}    AS currency,
        COUNT(*)::bigint      AS order_count,
        COUNT(DISTINCT ${orders.userId})::bigint AS unique_user_count,
        COALESCE(SUM(${orders.faceValueMinor}), 0)::bigint    AS face_value_minor,
        COALESCE(SUM(${orders.wholesaleMinor}), 0)::bigint    AS wholesale_minor,
        COALESCE(SUM(${orders.userCashbackMinor}), 0)::bigint AS user_cashback_minor,
        COALESCE(SUM(${orders.loopMarginMinor}), 0)::bigint   AS loop_margin_minor,
        MAX(${orders.fulfilledAt}) AS last_fulfilled_at
      FROM ${orders}
      WHERE ${orders.state} = 'fulfilled'
        AND ${orders.fulfilledAt} IS NOT NULL
        AND ${orders.fulfilledAt} >= ${since}
      GROUP BY ${orders.merchantId}, ${orders.currency}
      ORDER BY user_cashback_minor DESC, order_count DESC
    `);

    const rows = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const body: MerchantStatsResponse = {
      since: since.toISOString(),
      rows: rows.map((r) => ({
        merchantId: r.merchant_id,
        currency: r.currency,
        orderCount: toNumber(r.order_count),
        uniqueUserCount: toNumber(r.unique_user_count),
        faceValueMinor: toStringBigint(r.face_value_minor),
        wholesaleMinor: toStringBigint(r.wholesale_minor),
        userCashbackMinor: toStringBigint(r.user_cashback_minor),
        loopMarginMinor: toStringBigint(r.loop_margin_minor),
        lastFulfilledAt: toIso(r.last_fulfilled_at),
      })),
    };
    return c.json(body);
  } catch (err) {
    log.error({ err }, 'Admin merchant-stats query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to compute merchant stats' }, 500);
  }
}
