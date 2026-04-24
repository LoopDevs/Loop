/**
 * Admin treasury credit-flow time-series (ADR 009 / 015).
 *
 * `GET /api/admin/treasury/credit-flow?days=30&currency=USD` —
 * per-day sum of **credits issued vs debits settled** from the
 * `credit_transactions` ledger, by currency.
 *
 * The `/api/admin/treasury` snapshot tells ops *today's* outstanding
 * liability. This endpoint answers the treasury question the
 * snapshot can't: **"are we generating liability faster than we're
 * settling it?"**. A week of `netMinor > 0` days is a signal that
 * cashback issuance is outpacing user settlement — treasury needs
 * to plan Stellar-side funding ahead of the curve.
 *
 * Credited = sum(amount_minor) for positive-amount types
 *   (cashback, interest, refund) + positive adjustments.
 * Debited  = abs(sum(amount_minor)) for negative-amount types
 *   (spend, withdrawal) + absolute negative adjustments.
 * Net      = credited - debited (the day's liability delta).
 *
 * `?currency=USD|GBP|EUR` filters and guarantees zero-filled days
 * (stable chart layout). Without the filter, only (day, currency)
 * pairs with activity appear — no LEFT JOIN explosion across every
 * currency × every day.
 *
 * bigint-as-string on every money field (ADR 015). 180-day cap
 * is the usual treasury window — finance wants two quarters of
 * trend, and the index on `(created_at)` stays hot over that span.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditTransactions, HOME_CURRENCIES, type HomeCurrency } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-treasury-credit-flow' });

const MIN_DAYS = 1;
const MAX_DAYS = 180;
const DEFAULT_DAYS = 30;

// A2-1506: moved to `@loop/shared/admin-treasury.ts`. Re-exported
// for in-file handler builders.
import type { TreasuryCreditFlowDay, TreasuryCreditFlowResponse } from '@loop/shared';
export type { TreasuryCreditFlowDay, TreasuryCreditFlowResponse };

interface Row extends Record<string, unknown> {
  day: string | Date;
  currency: string;
  credited_minor: string | bigint | number;
  debited_minor: string | bigint | number;
}

function isHomeCurrency(v: string): v is HomeCurrency {
  return (HOME_CURRENCIES as ReadonlyArray<string>).includes(v);
}

export async function adminTreasuryCreditFlowHandler(c: Context): Promise<Response> {
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
    // When a currency filter is passed, LEFT JOIN generate_series to
    // zero-fill every day in the window so the chart draws a stable
    // line. Without the filter, activity-only rows avoid blowing up
    // the response across three currencies × N days.
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
            COALESCE(
              SUM(${creditTransactions.amountMinor})
                FILTER (WHERE ${creditTransactions.amountMinor} > 0),
              0
            )::text AS credited_minor,
            COALESCE(
              -SUM(${creditTransactions.amountMinor})
                FILTER (WHERE ${creditTransactions.amountMinor} < 0),
              0
            )::text AS debited_minor
          FROM days
          LEFT JOIN ${creditTransactions}
            ON DATE_TRUNC('day', ${creditTransactions.createdAt} AT TIME ZONE 'UTC') = days.day
           AND ${creditTransactions.currency} = ${currencyFilter}
          GROUP BY days.day
          ORDER BY days.day ASC
        `)
      : await db.execute<Row>(sql`
          SELECT
            TO_CHAR(DATE_TRUNC('day', ${creditTransactions.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
            ${creditTransactions.currency} AS currency,
            COALESCE(
              SUM(${creditTransactions.amountMinor})
                FILTER (WHERE ${creditTransactions.amountMinor} > 0),
              0
            )::text AS credited_minor,
            COALESCE(
              -SUM(${creditTransactions.amountMinor})
                FILTER (WHERE ${creditTransactions.amountMinor} < 0),
              0
            )::text AS debited_minor
          FROM ${creditTransactions}
          WHERE ${creditTransactions.createdAt} >=
            DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC') - INTERVAL '1 day' * (${windowDays} - 1)
          GROUP BY DATE_TRUNC('day', ${creditTransactions.createdAt} AT TIME ZONE 'UTC'),
                   ${creditTransactions.currency}
          ORDER BY day ASC, currency ASC
        `);

    const rows: Row[] = Array.isArray(result)
      ? (result as Row[])
      : ((result as { rows?: Row[] }).rows ?? []);

    const days: TreasuryCreditFlowDay[] = rows.map((r) => {
      const credited = BigInt(String(r.credited_minor));
      const debited = BigInt(String(r.debited_minor));
      const net = credited - debited;
      return {
        day: typeof r.day === 'string' ? r.day : r.day.toISOString().slice(0, 10),
        currency: r.currency,
        creditedMinor: credited.toString(),
        debitedMinor: debited.toString(),
        netMinor: net.toString(),
      };
    });

    return c.json<TreasuryCreditFlowResponse>({
      windowDays,
      currency: currencyFilter,
      days,
    });
  } catch (err) {
    log.error({ err }, 'Treasury credit-flow query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load treasury credit flow' }, 500);
  }
}
