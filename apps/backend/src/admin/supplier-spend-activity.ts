/**
 * Admin supplier-spend activity time-series (ADR 013 / 015).
 *
 * `GET /api/admin/supplier-spend/activity?days=30&currency=USD` —
 * per-day aggregate of what Loop paid CTX across fulfilled orders,
 * bucketed by `fulfilledAt` (UTC).
 *
 * Snapshot (`/api/admin/supplier-spend`) tells ops *how much* we
 * paid CTX in the rolling window. This endpoint tells them *when*
 * — the daily velocity of supplier outflow.
 *
 * Pairs with two other treasury-velocity feeds:
 *   - credit-flow       — per-day ledger delta (liability in)
 *   - payouts-activity  — per-day Stellar settlement (liability out)
 *   - supplier-spend/activity  — per-day CTX outflow (this file)
 *
 * Together they answer "did money move in/out as expected today?"
 * for finance and treasury.
 *
 * `?currency=USD|GBP|EUR` filters and zero-fills days via LEFT
 * JOIN generate_series. Without the filter, only (day, currency)
 * pairs with activity are returned.
 *
 * bigint-as-string on every money field (ADR 015). ?days clamped
 * [1, 180] — two quarters of trend for month-end reviews.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders, HOME_CURRENCIES, type HomeCurrency } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-supplier-spend-activity' });

const MIN_DAYS = 1;
const MAX_DAYS = 180;
const DEFAULT_DAYS = 30;

// A2-1506: moved to `@loop/shared/admin-supplier-spend.ts`.
import type { SupplierSpendActivityDay, SupplierSpendActivityResponse } from '@loop/shared';
export type { SupplierSpendActivityDay, SupplierSpendActivityResponse };

interface Row extends Record<string, unknown> {
  day: string | Date;
  currency: string;
  count: string | number | bigint;
  face_value_minor: string | bigint;
  wholesale_minor: string | bigint;
  user_cashback_minor: string | bigint;
  loop_margin_minor: string | bigint;
}

function isHomeCurrency(v: string): v is HomeCurrency {
  return (HOME_CURRENCIES as ReadonlyArray<string>).includes(v);
}

export async function adminSupplierSpendActivityHandler(c: Context): Promise<Response> {
  const daysRaw = c.req.query('days');
  const parsedDays = Number.parseInt(daysRaw ?? String(DEFAULT_DAYS), 10);
  const windowDays = Math.min(
    Math.max(Number.isNaN(parsedDays) ? DEFAULT_DAYS : parsedDays, MIN_DAYS),
    MAX_DAYS,
  );

  const currencyRaw = c.req.query('currency');
  let currencyFilter: HomeCurrency | null = null;
  if (currencyRaw !== undefined && currencyRaw.length > 0) {
    const upper = currencyRaw.toUpperCase();
    if (!isHomeCurrency(upper)) {
      return c.json(
        {
          code: 'VALIDATION_ERROR',
          message: `currency must be one of ${HOME_CURRENCIES.join(', ')}`,
        },
        400,
      );
    }
    currencyFilter = upper;
  }

  try {
    // A2-904: GROUP BY charge_currency (not catalog `currency`) — see
    // supplier-spend.ts for the rationale. The `currency` response
    // field keeps its name for wire-compat but means charge_currency.
    // The `currencyFilter` query param likewise now filters on
    // charge_currency so filter + aggregate agree.
    const result = currencyFilter
      ? await db.execute<Row>(sql`
          WITH days AS (
            SELECT generate_series(
              DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC') - INTERVAL '1 day' * (${windowDays} - 1),
              DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC'),
              INTERVAL '1 day'
            ) AS day
          )
          SELECT
            TO_CHAR(days.day, 'YYYY-MM-DD') AS day,
            ${currencyFilter}::text AS currency,
            COALESCE(COUNT(${orders.id}), 0)::bigint AS count,
            COALESCE(SUM(${orders.faceValueMinor}), 0)::text AS face_value_minor,
            COALESCE(SUM(${orders.wholesaleMinor}), 0)::text AS wholesale_minor,
            COALESCE(SUM(${orders.userCashbackMinor}), 0)::text AS user_cashback_minor,
            COALESCE(SUM(${orders.loopMarginMinor}), 0)::text AS loop_margin_minor
          FROM days
          LEFT JOIN ${orders}
            ON DATE_TRUNC('day', ${orders.fulfilledAt} AT TIME ZONE 'UTC') = days.day
           AND ${orders.state} = 'fulfilled'
           AND ${orders.chargeCurrency} = ${currencyFilter}
          GROUP BY days.day
          ORDER BY days.day ASC
        `)
      : await db.execute<Row>(sql`
          SELECT
            TO_CHAR(DATE_TRUNC('day', ${orders.fulfilledAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
            ${orders.chargeCurrency} AS currency,
            COUNT(*)::bigint AS count,
            COALESCE(SUM(${orders.faceValueMinor}), 0)::text AS face_value_minor,
            COALESCE(SUM(${orders.wholesaleMinor}), 0)::text AS wholesale_minor,
            COALESCE(SUM(${orders.userCashbackMinor}), 0)::text AS user_cashback_minor,
            COALESCE(SUM(${orders.loopMarginMinor}), 0)::text AS loop_margin_minor
          FROM ${orders}
          WHERE ${orders.state} = 'fulfilled'
            AND ${orders.fulfilledAt} IS NOT NULL
            AND ${orders.fulfilledAt} >=
              DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC') - INTERVAL '1 day' * (${windowDays} - 1)
          GROUP BY DATE_TRUNC('day', ${orders.fulfilledAt} AT TIME ZONE 'UTC'),
                   ${orders.chargeCurrency}
          ORDER BY day ASC, currency ASC
        `);

    const rows: Row[] = Array.isArray(result)
      ? (result as Row[])
      : ((result as { rows?: Row[] }).rows ?? []);

    const days: SupplierSpendActivityDay[] = rows.map((r) => ({
      day: typeof r.day === 'string' ? r.day : r.day.toISOString().slice(0, 10),
      currency: r.currency,
      count: Number(r.count),
      faceValueMinor: String(r.face_value_minor),
      wholesaleMinor: String(r.wholesale_minor),
      userCashbackMinor: String(r.user_cashback_minor),
      loopMarginMinor: String(r.loop_margin_minor),
    }));

    return c.json<SupplierSpendActivityResponse>({
      windowDays,
      currency: currencyFilter,
      days,
    });
  } catch (err) {
    log.error({ err }, 'Supplier-spend activity query failed');
    return c.json(
      { code: 'INTERNAL_ERROR', message: 'Failed to load supplier-spend activity' },
      500,
    );
  }
}
