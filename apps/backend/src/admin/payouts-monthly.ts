/**
 * Admin fleet-wide payouts-monthly aggregate (ADR 015/016).
 *
 * `GET /api/admin/payouts-monthly` — last 12 calendar months of
 * confirmed on-chain Stellar payouts, grouped by `(month, assetCode)`.
 *
 * Settlement-side counterpart to `/api/admin/cashback-monthly`:
 * cashback-monthly tracks liability creation (user_credit +
 * cashback-type rows); this one tracks liability settlement
 * (pending_payouts rows that made it to state='confirmed' on
 * Stellar). Together they answer the ADR-015 treasury question —
 * "is outstanding liability growing or shrinking?" — at monthly
 * resolution.
 *
 * Invariants match the cashback-monthly sibling:
 *   - Fixed 12-month window (current UTC month + previous 11).
 *   - Filtered to `state='confirmed'` — pending / submitted rows
 *     haven't actually settled yet.
 *   - Oldest-first ordering so the chart renders left-to-right.
 *   - One entry per (month, assetCode); multi-asset safe.
 *   - bigint-as-string on the wire (stroops — 7 decimals, easily
 *     exceeds Number.MAX_SAFE_INTEGER once Loop has non-trivial
 *     payout volume).
 *
 * Zero-volume months for an asset that has seen activity at some
 * point are NOT zero-filled — consumers of the 12-month series
 * should zero-fill client-side if they want stable bar chart
 * rendering. (Same convention as cashback-monthly.)
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pendingPayouts } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-payouts-monthly' });

export interface AdminPayoutsMonthlyEntry {
  /** "YYYY-MM" in UTC. */
  month: string;
  /** LOOP asset code — USDLOOP / GBPLOOP / EURLOOP, or any future addition. */
  assetCode: string;
  /** SUM(amount_stroops) of confirmed payouts in this (month, asset). bigint-as-string. */
  paidStroops: string;
  /** Count of confirmed payouts in this (month, asset). */
  payoutCount: number;
}

export interface AdminPayoutsMonthlyResponse {
  entries: AdminPayoutsMonthlyEntry[];
}

interface AggRow {
  month: string | Date;
  asset_code: string;
  paid_stroops: string | number | bigint | null;
  payout_count: string | number | bigint | null;
}

function formatMonth(m: string | Date): string {
  if (m instanceof Date) {
    const yyyy = m.getUTCFullYear().toString().padStart(4, '0');
    const mm = (m.getUTCMonth() + 1).toString().padStart(2, '0');
    return `${yyyy}-${mm}`;
  }
  // Postgres DATE_TRUNC returns a timestamptz — pg driver stringifies
  // it like "2026-04-01 00:00:00+00". Take the "YYYY-MM" prefix.
  return m.slice(0, 7);
}

function toNumber(v: string | number | bigint | null): number {
  if (v === null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  return Number.parseInt(v, 10);
}

function toStringBigint(v: string | number | bigint | null): string {
  if (v === null) return '0';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Math.trunc(v).toString();
  return v;
}

export async function adminPayoutsMonthlyHandler(c: Context): Promise<Response> {
  try {
    const result = await db.execute(sql`
      SELECT
        DATE_TRUNC('month', ${pendingPayouts.confirmedAt} AT TIME ZONE 'UTC') AS month,
        ${pendingPayouts.assetCode}                                           AS asset_code,
        COALESCE(SUM(${pendingPayouts.amountStroops}), 0)::bigint             AS paid_stroops,
        COUNT(*)::bigint                                                      AS payout_count
      FROM ${pendingPayouts}
      WHERE ${pendingPayouts.state} = 'confirmed'
        AND ${pendingPayouts.confirmedAt} IS NOT NULL
        AND ${pendingPayouts.confirmedAt} >= DATE_TRUNC(
          'month',
          (NOW() AT TIME ZONE 'UTC') - INTERVAL '11 months'
        )
      GROUP BY month, ${pendingPayouts.assetCode}
      ORDER BY month ASC, asset_code ASC
    `);

    const rawRows = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const entries: AdminPayoutsMonthlyEntry[] = rawRows.map((r) => ({
      month: formatMonth(r.month),
      assetCode: r.asset_code,
      paidStroops: toStringBigint(r.paid_stroops),
      payoutCount: toNumber(r.payout_count),
    }));

    return c.json<AdminPayoutsMonthlyResponse>({ entries });
  } catch (err) {
    log.error({ err }, 'Admin payouts-monthly query failed');
    return c.json(
      { code: 'INTERNAL_ERROR', message: 'Failed to load payouts-monthly aggregate' },
      500,
    );
  }
}
