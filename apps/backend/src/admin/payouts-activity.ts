/**
 * Admin payouts-activity time-series (#637).
 *
 * `GET /api/admin/payouts-activity?days=30` — daily confirmed-
 * payout aggregate for the admin dashboard's payout sparkline.
 * Settlement-side counterpart to `/api/admin/cashback-activity`:
 *   - cashback-activity tracks *creation* (credit_transactions
 *     rows of type='cashback' per day)
 *   - payouts-activity tracks *settlement* (pending_payouts rows
 *     that confirmed on-chain per day)
 *
 * Grouped per day AND per LOOP asset code so the admin UI can
 * render a stacked bar chart / separate sparklines per asset.
 * Every day in the window has a row — a LEFT JOIN
 * `generate_series` keeps zero-activity days as `count: 0,
 * byAsset: []`, so the chart's x-axis stays dense.
 *
 * Window: `?days=` (default 30, max 180). Matches the cashback-
 * activity window shape exactly so callers can swap endpoints
 * without relearning the parameter.
 *
 * Bucketed on `confirmed_at::date` — the day the liability
 * settled, not the day the payout was queued. A payout that sat
 * in state='submitted' for 48h before Horizon confirmed lands in
 * the confirmation day's bucket (correct for reconciliation).
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-payouts-activity' });

const DEFAULT_DAYS = 30;
const MAX_DAYS = 180;

export interface PerAssetAmount {
  assetCode: string;
  /** SUM(amount_stroops) for this (day, asset). bigint-as-string. */
  stroops: string;
  /** Count of confirmed payouts in this (day, asset). */
  count: number;
}

export interface PayoutsActivityDay {
  /** YYYY-MM-DD (UTC). */
  day: string;
  /** Total confirmed-payout count across every asset on this day. */
  count: number;
  /** One entry per asset that saw activity; empty on zero-day. */
  byAsset: PerAssetAmount[];
}

export interface PayoutsActivityResponse {
  days: number;
  rows: PayoutsActivityDay[];
}

interface AggRow {
  day: string | Date;
  asset_code: string | null;
  count: string | number | bigint;
  stroops: string | number | bigint;
}

function toYmd(day: string | Date): string {
  if (typeof day === 'string') return day.slice(0, 10);
  return day.toISOString().slice(0, 10);
}

function toNumber(value: string | number | bigint): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return Number.parseInt(value, 10);
}

function toStringBigint(value: string | number | bigint): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Math.trunc(value).toString();
  return value;
}

export async function adminPayoutsActivityHandler(c: Context): Promise<Response> {
  const daysRaw = c.req.query('days');
  const parsedDays = Number.parseInt(daysRaw ?? `${DEFAULT_DAYS}`, 10);
  const days = Math.min(
    Math.max(Number.isNaN(parsedDays) ? DEFAULT_DAYS : parsedDays, 1),
    MAX_DAYS,
  );

  try {
    const result = await db.execute(sql`
      WITH days AS (
        SELECT generate_series(
          (CURRENT_DATE - (${days - 1}::int))::date,
          CURRENT_DATE,
          '1 day'::interval
        )::date AS d
      )
      SELECT
        days.d::text                               AS day,
        pp.asset_code                              AS asset_code,
        COUNT(pp.id)::bigint                       AS count,
        COALESCE(SUM(pp.amount_stroops), 0)::bigint AS stroops
      FROM days
      LEFT JOIN pending_payouts pp
        ON pp.state = 'confirmed'
        AND pp.confirmed_at IS NOT NULL
        AND pp.confirmed_at::date = days.d
      GROUP BY days.d, pp.asset_code
      ORDER BY days.d ASC, pp.asset_code ASC NULLS LAST
    `);

    const rawRows = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    // Pivot (day, asset) rows → one entry per day with a byAsset list.
    const byDay = new Map<string, PayoutsActivityDay>();
    for (const r of rawRows) {
      const day = toYmd(r.day);
      let entry = byDay.get(day);
      if (entry === undefined) {
        entry = { day, count: 0, byAsset: [] };
        byDay.set(day, entry);
      }
      if (r.asset_code !== null) {
        const c = toNumber(r.count);
        entry.count += c;
        entry.byAsset.push({
          assetCode: r.asset_code,
          stroops: toStringBigint(r.stroops),
          count: c,
        });
      }
      // asset_code === null rows come from the LEFT-JOIN zero-day
      // case — entry is already seeded as count: 0.
    }

    const ordered = Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
    return c.json<PayoutsActivityResponse>({ days, rows: ordered });
  } catch (err) {
    log.error({ err }, 'Admin payouts-activity query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to compute payouts activity' }, 500);
  }
}
