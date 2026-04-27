/**
 * Admin per-merchant flywheel share (ADR 011 / 015).
 *
 * `GET /api/admin/merchants/flywheel-share?since=<iso>&limit=<n>`
 * — per-merchant breakdown of fulfilled-order count and charge that
 * came through the LOOP-asset rail (recycled cashback), vs the
 * total-fulfilled denominator for the same merchant in the same
 * window.
 *
 * The merchant-axis cousin of `/api/admin/orders/payment-method-
 * share` (which is fleet-wide) and `/api/admin/orders/payment-method-
 * activity` (which is time-axis). Ops uses this to answer:
 *   - which merchants see the most cashback-recycling traffic (a
 *     ranked leaderboard); i.e. which ones are part of the flywheel
 *     today
 *   - where to prioritise CTX negotiations when allocating LOOP-
 *     asset liquidity
 *
 * Sorted by `recycledOrderCount` descending so flywheel-leading
 * merchants surface first. Merchants with zero recycled orders are
 * omitted entirely — the signal is "this is the ranking of
 * recyclers", not a zero-inflated fleet-wide list.
 *
 * Window: `?since=<iso>` (default 31 days ago, cap 366 days).
 * `?limit=` clamp 1..100, default 25.
 * bigint-as-string on the wire for every `*_minor`.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-merchants-flywheel-share' });

const DEFAULT_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export interface MerchantFlywheelShareRow {
  merchantId: string;
  /** Total fulfilled orders at this merchant in the window. */
  totalFulfilledCount: number;
  /** Of those, the subset paid with `payment_method = 'loop_asset'`. */
  recycledOrderCount: number;
  /** SUM(charge_minor) over recycled orders. bigint-as-string. */
  recycledChargeMinor: string;
  /** SUM(charge_minor) over every fulfilled order. bigint-as-string. */
  totalChargeMinor: string;
}

export interface MerchantsFlywheelShareResponse {
  since: string;
  rows: MerchantFlywheelShareRow[];
}

interface AggRow extends Record<string, unknown> {
  merchantId: string;
  totalFulfilledCount: string | number;
  recycledOrderCount: string | number;
  recycledChargeMinor: string | number | bigint;
  totalChargeMinor: string | number | bigint;
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

export async function adminMerchantsFlywheelShareHandler(c: Context): Promise<Response> {
  const sinceRaw = c.req.query('since');
  let since: Date;
  const now = Date.now();
  if (sinceRaw !== undefined && sinceRaw.length > 0) {
    const d = new Date(sinceRaw);
    if (Number.isNaN(d.getTime())) {
      return c.json(
        { code: 'VALIDATION_ERROR', message: 'since must be an ISO-8601 timestamp' },
        400,
      );
    }
    // Clamp the window so a handcrafted `?since=1970-...` can't
    // produce an unbounded full-table aggregate.
    const ageMs = now - d.getTime();
    if (ageMs > MAX_WINDOW_MS) {
      since = new Date(now - MAX_WINDOW_MS);
    } else if (ageMs < 0) {
      // Future timestamp → treat as "no window" (everything fulfilled
      // before now). Rare, but reject early rather than return an
      // empty result silently.
      return c.json({ code: 'VALIDATION_ERROR', message: 'since must not be in the future' }, 400);
    } else {
      since = d;
    }
  } else {
    since = new Date(now - DEFAULT_WINDOW_MS);
  }

  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? String(DEFAULT_LIMIT), 10);
  const limit = Math.min(
    Math.max(Number.isNaN(parsedLimit) ? DEFAULT_LIMIT : parsedLimit, 1),
    MAX_LIMIT,
  );

  try {
    const result = await db.execute<AggRow>(sql`
      SELECT
        ${orders.merchantId}                                      AS "merchantId",
        COUNT(*)::int                                             AS "totalFulfilledCount",
        COUNT(*) FILTER (
          WHERE ${orders.paymentMethod} = 'loop_asset'
        )::int                                                    AS "recycledOrderCount",
        COALESCE(
          SUM(${orders.chargeMinor}) FILTER (
            WHERE ${orders.paymentMethod} = 'loop_asset'
          ),
          0
        )::bigint                                                 AS "recycledChargeMinor",
        COALESCE(SUM(${orders.chargeMinor}), 0)::bigint           AS "totalChargeMinor"
      FROM ${orders}
      WHERE ${orders.state} = 'fulfilled'
        AND ${orders.fulfilledAt} IS NOT NULL
        AND ${orders.fulfilledAt} >= ${since.toISOString()}
      GROUP BY ${orders.merchantId}
      HAVING COUNT(*) FILTER (WHERE ${orders.paymentMethod} = 'loop_asset') > 0
      ORDER BY
        COUNT(*) FILTER (WHERE ${orders.paymentMethod} = 'loop_asset') DESC,
        COUNT(*) DESC
      LIMIT ${limit}
    `);
    const raw: AggRow[] = Array.isArray(result)
      ? (result as AggRow[])
      : ((result as { rows?: AggRow[] }).rows ?? []);

    const rows: MerchantFlywheelShareRow[] = raw.map((r) => ({
      merchantId: r.merchantId,
      totalFulfilledCount: toNumber(r.totalFulfilledCount),
      recycledOrderCount: toNumber(r.recycledOrderCount),
      recycledChargeMinor: toStringBigint(r.recycledChargeMinor),
      totalChargeMinor: toStringBigint(r.totalChargeMinor),
    }));

    return c.json<MerchantsFlywheelShareResponse>({
      since: since.toISOString(),
      rows,
    });
  } catch (err) {
    log.error({ err }, 'Admin merchants-flywheel-share query failed');
    return c.json(
      { code: 'INTERNAL_ERROR', message: 'Failed to load merchants flywheel share' },
      500,
    );
  }
}
