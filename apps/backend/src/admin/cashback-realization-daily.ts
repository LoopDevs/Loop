/**
 * Admin cashback-realization daily trend (ADR 009 / 015).
 *
 * `GET /api/admin/cashback-realization/daily?days=N` — time series
 * that answers "is the flywheel turning harder or slower over
 * time?". Paired with the single-point realization card (#727/#730)
 * as the drift-over-time view.
 *
 * Each row bucketed by date + currency:
 *   - `earnedMinor`   = SUM amount_minor WHERE type='cashback'
 *   - `spentMinor`    = ABS SUM amount_minor WHERE type='spend'
 *   - `recycledBps`   = spent / earned × 10 000 (per-currency only)
 *
 * Dense output via `generate_series` LEFT JOIN so zero-activity
 * days emit `earnedMinor: '0', spentMinor: '0', recycledBps: 0`.
 * Sparkline rendering needs the dense shape — missing days would
 * compress the x-axis and make gaps look like plateaus.
 *
 * Window: `?days=30` default, 1..180 clamp. Matches the other
 * admin sparkline endpoints so a single shared chart component
 * can render either series.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { recycledBps } from '@loop/shared';
import { db } from '../db/client.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-cashback-realization-daily' });

export interface RealizationDay {
  day: string;
  currency: string;
  earnedMinor: string;
  spentMinor: string;
  recycledBps: number;
}

export interface RealizationDailyResponse {
  days: number;
  rows: RealizationDay[];
}

const DEFAULT_DAYS = 30;
const MAX_DAYS = 180;

interface AggRow extends Record<string, unknown> {
  day: string | Date;
  currency: string | null;
  earned_minor: string | number | bigint | null;
  spent_minor: string | number | bigint | null;
}

function toStringBigint(v: string | number | bigint | null): string {
  if (v === null) return '0';
  if (typeof v === 'bigint') return v.toString();
  return String(v);
}

function toYmd(v: string | Date): string {
  if (typeof v === 'string') return v.slice(0, 10);
  return v.toISOString().slice(0, 10);
}

// `recycledBps` re-exported from @loop/shared so existing test
// imports (`from '../cashback-realization-daily.js'`) keep resolving.
export { recycledBps };

export async function adminCashbackRealizationDailyHandler(c: Context): Promise<Response> {
  const daysRaw = c.req.query('days');
  const parsedDays = Number.parseInt(daysRaw ?? String(DEFAULT_DAYS), 10);
  const days = Math.min(
    Math.max(Number.isNaN(parsedDays) ? DEFAULT_DAYS : parsedDays, 1),
    MAX_DAYS,
  );

  try {
    // LEFT JOIN on generate_series gives zero-activity days a row
    // with currency=NULL. Those get collapsed to an empty-day marker
    // post-query. `FILTER (WHERE ...)` keeps the earned / spent
    // buckets separated inside a single GROUP BY.
    const result = await db.execute<AggRow>(sql`
      WITH days AS (
        SELECT generate_series(
          (CURRENT_DATE - (${days - 1}::int))::date,
          CURRENT_DATE,
          '1 day'::interval
        )::date AS d
      )
      SELECT
        days.d::text AS day,
        ct.currency,
        COALESCE(
          SUM(ct.amount_minor) FILTER (WHERE ct.type = 'cashback'),
          0
        )::text AS earned_minor,
        ABS(
          COALESCE(
            SUM(ct.amount_minor) FILTER (WHERE ct.type = 'spend'),
            0
          )
        )::text AS spent_minor
      FROM days
      LEFT JOIN credit_transactions ct
        ON ct.created_at::date = days.d
        AND ct.type IN ('cashback', 'spend')
      GROUP BY days.d, ct.currency
      ORDER BY days.d ASC, ct.currency ASC NULLS LAST
    `);

    const raw = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const rows: RealizationDay[] = [];
    for (const r of raw) {
      if (r.currency === null) continue; // zero-day LEFT JOIN row
      const earned = BigInt(toStringBigint(r.earned_minor));
      const spent = BigInt(toStringBigint(r.spent_minor));
      rows.push({
        day: toYmd(r.day),
        currency: r.currency,
        earnedMinor: earned.toString(),
        spentMinor: spent.toString(),
        recycledBps: recycledBps(earned, spent),
      });
    }
    return c.json<RealizationDailyResponse>({ days, rows });
  } catch (err) {
    log.error({ err }, 'Cashback realization daily aggregation failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to compute realization trend' }, 500);
  }
}
