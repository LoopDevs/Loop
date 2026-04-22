/**
 * Admin daily-cashback activity (ADR 009 / 019 Tier 1).
 *
 * `GET /api/admin/cashback/activity?days=7` — per-day totals of
 * cashback paid out, bucketed by currency. Answers ops's "did we
 * pay out more cashback today than yesterday?" without aggregating
 * the ledger client-side. Paired with `/api/admin/orders/activity`
 * (#446) which tracks order volume; together they tell the cashback
 * story per day.
 *
 * Same `generate_series` + LEFT JOIN trick as orders-activity so
 * every day in the window appears with zero-filled per-currency
 * entries. Only `type='cashback'` rows count — adjustments / spend
 * / withdrawals / refunds belong in a different view.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditTransactions } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-cashback-activity' });

export interface CashbackActivityDay {
  /** YYYY-MM-DD in UTC. */
  day: string;
  /** Per-currency totals. Populated for every currency that appeared
   * anywhere in the window — empty `{}` on a day with zero activity. */
  byCurrency: Record<string, { cashbackMinor: string; events: number }>;
}

export interface AdminCashbackActivityResponse {
  days: CashbackActivityDay[];
  windowDays: number;
}

interface Row extends Record<string, unknown> {
  day: string | Date;
  currency: string | null;
  cashbackMinor: string | null;
  events: string | number;
}

export async function adminCashbackActivityHandler(c: Context): Promise<Response> {
  const daysRaw = c.req.query('days');
  const parsedDays = Number.parseInt(daysRaw ?? '7', 10);
  const windowDays = Math.min(Math.max(Number.isNaN(parsedDays) ? 7 : parsedDays, 1), 90);

  try {
    // LEFT JOIN `generate_series` so every day appears; GROUP BY
    // (day, currency) gives per-currency-per-day rows, plus a
    // NULL-currency row for days with zero cashback (we filter
    // those out in post).
    const result = await db.execute<Row>(sql`
      WITH days AS (
        SELECT generate_series(
          DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC') - INTERVAL '1 day' * (${windowDays} - 1),
          DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC'),
          INTERVAL '1 day'
        ) AS day
      )
      SELECT
        TO_CHAR(days.day, 'YYYY-MM-DD') AS day,
        ${creditTransactions.currency} AS currency,
        COALESCE(SUM(${creditTransactions.amountMinor}), 0)::bigint AS "cashbackMinor",
        COALESCE(COUNT(${creditTransactions.id}), 0)::bigint AS events
      FROM days
      LEFT JOIN ${creditTransactions}
        ON DATE_TRUNC('day', ${creditTransactions.createdAt} AT TIME ZONE 'UTC') = days.day
        AND ${creditTransactions.type} = 'cashback'
      GROUP BY days.day, ${creditTransactions.currency}
      ORDER BY days.day ASC, ${creditTransactions.currency} ASC NULLS LAST
    `);
    const rows: Row[] = Array.isArray(result)
      ? (result as Row[])
      : ((result as { rows?: Row[] }).rows ?? []);

    // Pivot into one entry per day with a nested per-currency map.
    const byDay = new Map<string, CashbackActivityDay>();
    for (const r of rows) {
      const day = typeof r.day === 'string' ? r.day : r.day.toISOString().slice(0, 10);
      if (!byDay.has(day)) {
        byDay.set(day, { day, byCurrency: {} });
      }
      // r.currency is null for days with zero cashback rows (the
      // LEFT-JOIN-produced null row) — skip populating byCurrency
      // for those; the empty `{}` is the correct "no activity" shape.
      if (r.currency !== null && r.currency !== undefined) {
        const entry = byDay.get(day);
        if (entry !== undefined) {
          entry.byCurrency[r.currency] = {
            cashbackMinor: (r.cashbackMinor ?? '0').toString(),
            events: Number(r.events),
          };
        }
      }
    }

    // Preserve oldest-first order by iterating the rows (which are
    // already ASC), not Map insertion order alone.
    const days: CashbackActivityDay[] = Array.from(byDay.values());

    return c.json<AdminCashbackActivityResponse>({ days, windowDays });
  } catch (err) {
    log.error({ err }, 'Admin cashback-activity query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load cashback activity' }, 500);
  }
}
