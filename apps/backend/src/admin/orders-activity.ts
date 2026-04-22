/**
 * Admin daily-orders activity (ADR 010 / 019 Tier 1).
 *
 * `GET /api/admin/orders/activity?days=7` — per-day counts of
 * orders created vs fulfilled for the last `days` calendar days
 * (UTC-bucketed). Drives the admin dashboard's activity sparkline
 * and answers "did we fulfill more today than yesterday?" at a
 * glance.
 *
 * Single query with `generate_series` on the left to guarantee
 * every day in the window appears with zero-filled counts even
 * when no orders crossed on that day. No client-side gap-filling
 * needed.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-orders-activity' });

export interface ActivityDay {
  /** YYYY-MM-DD in UTC. */
  day: string;
  created: number;
  fulfilled: number;
}

export interface AdminOrdersActivityResponse {
  /** Oldest-first so a bar chart renders left-to-right. */
  days: ActivityDay[];
  /** Echoed so clients can show a "Last N days" label. */
  windowDays: number;
}

interface Row extends Record<string, unknown> {
  day: string | Date;
  created: string | number;
  fulfilled: string | number;
}

export async function adminOrdersActivityHandler(c: Context): Promise<Response> {
  const daysRaw = c.req.query('days');
  const parsedDays = Number.parseInt(daysRaw ?? '7', 10);
  // Floor 1 (anything less is noise), cap 90 (a quarter of daily
  // buckets fits on a sensible chart; beyond that switch to monthly).
  const windowDays = Math.min(Math.max(Number.isNaN(parsedDays) ? 7 : parsedDays, 1), 90);

  try {
    // LEFT JOIN generate_series so every day in the window appears,
    // even when zero orders fell on it — stable chart layout.
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
        COALESCE(COUNT(${orders.id}), 0)::bigint AS created,
        COALESCE(
          COUNT(${orders.id}) FILTER (WHERE ${orders.state} = 'fulfilled'),
          0
        )::bigint AS fulfilled
      FROM days
      LEFT JOIN ${orders}
        ON DATE_TRUNC('day', ${orders.createdAt} AT TIME ZONE 'UTC') = days.day
      GROUP BY days.day
      ORDER BY days.day ASC
    `);
    const rows: Row[] = Array.isArray(result)
      ? (result as Row[])
      : ((result as { rows?: Row[] }).rows ?? []);

    const daysOut: ActivityDay[] = rows.map((r) => ({
      day: typeof r.day === 'string' ? r.day : r.day.toISOString().slice(0, 10),
      created: Number(r.created),
      fulfilled: Number(r.fulfilled),
    }));

    return c.json<AdminOrdersActivityResponse>({
      days: daysOut,
      windowDays,
    });
  } catch (err) {
    log.error({ err }, 'Admin orders-activity query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load orders activity' }, 500);
  }
}
