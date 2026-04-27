/**
 * Admin users-recycling-activity endpoint (ADR 011 / 015).
 *
 * `GET /api/admin/users/recycling-activity?limit=<n>` — ranked list
 * of users who have placed at least one LOOP-asset paid order,
 * sorted by their most-recent loop_asset order time. Answers the
 * ops question: *"who's recycling cashback right now?"*
 *
 * Complement to the existing admin surfaces:
 *   - `/admin/top-users` (by cashback earned — source-side)
 *   - `/admin/top-users-by-pending-payout` (by on-chain backlog)
 *   - `/admin/users/recycling-activity` ← this one (by recycle)
 *
 * Focus: ops wants a "flywheel participants" list, not the full
 * user directory. Zero-recycle users are omitted entirely — the
 * signal is "who's in the loop", not a zero-inflated enumeration.
 *
 * Window: rolling 90 days (most-recent-loop_asset-within-window).
 * Past-90d recyclers who've gone silent are not returned — the
 * ranking is about current activity. Users with older recycling
 * surface via `/admin/users/:id/flywheel-stats` on their drill-down.
 *
 * `?limit=` clamp 1..100, default 25.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-users-recycling-activity' });

const WINDOW_DAYS = 90;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export interface UserRecyclingActivityRow {
  userId: string;
  email: string;
  /** Most-recent loop_asset order time in the window. ISO-8601. */
  lastRecycledAt: string;
  /** Count of loop_asset orders in the window (any state). */
  recycledOrderCount: number;
  /** SUM(charge_minor) over loop_asset orders in the window, any state. bigint-as-string. */
  recycledChargeMinor: string;
  /** User's current home currency — denomination of chargeMinor. */
  currency: string;
}

export interface UsersRecyclingActivityResponse {
  since: string;
  rows: UserRecyclingActivityRow[];
}

interface AggRow extends Record<string, unknown> {
  userId: string;
  email: string;
  lastRecycledAt: string | Date;
  recycledOrderCount: string | number;
  recycledChargeMinor: string | number | bigint;
  currency: string;
}

function toNumber(value: string | number): number {
  return typeof value === 'number' ? value : Number.parseInt(value, 10);
}

function toStringBigint(value: string | number | bigint): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Math.trunc(value).toString();
  return value;
}

export async function adminUsersRecyclingActivityHandler(c: Context): Promise<Response> {
  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? String(DEFAULT_LIMIT), 10);
  const limit = Math.min(
    Math.max(Number.isNaN(parsedLimit) ? DEFAULT_LIMIT : parsedLimit, 1),
    MAX_LIMIT,
  );
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  try {
    // Join orders→users so we surface the email alongside the
    // aggregate. GROUP BY (user, email, home_currency) — a user
    // row only changes home_currency pre-first-order, so this
    // grouping is effectively per-user in practice.
    const result = await db.execute<AggRow>(sql`
      SELECT
        u.id              AS "userId",
        u.email           AS "email",
        u.home_currency   AS "currency",
        MAX(o.created_at) AS "lastRecycledAt",
        COUNT(o.id)::int  AS "recycledOrderCount",
        COALESCE(SUM(o.charge_minor), 0)::bigint AS "recycledChargeMinor"
      FROM users u
      INNER JOIN orders o ON o.user_id = u.id
      WHERE o.payment_method = 'loop_asset'
        AND o.created_at >= ${since.toISOString()}
      GROUP BY u.id, u.email, u.home_currency
      ORDER BY MAX(o.created_at) DESC
      LIMIT ${limit}
    `);
    const raw: AggRow[] = Array.isArray(result)
      ? (result as AggRow[])
      : ((result as { rows?: AggRow[] }).rows ?? []);

    const rows: UserRecyclingActivityRow[] = raw.map((r) => ({
      userId: r.userId,
      email: r.email,
      lastRecycledAt:
        r.lastRecycledAt instanceof Date
          ? r.lastRecycledAt.toISOString()
          : new Date(r.lastRecycledAt).toISOString(),
      recycledOrderCount: toNumber(r.recycledOrderCount),
      recycledChargeMinor: toStringBigint(r.recycledChargeMinor),
      currency: r.currency,
    }));

    return c.json<UsersRecyclingActivityResponse>({
      since: since.toISOString(),
      rows,
    });
  } catch (err) {
    log.error({ err }, 'Admin users-recycling-activity query failed');
    return c.json(
      { code: 'INTERNAL_ERROR', message: 'Failed to load users recycling activity' },
      500,
    );
  }
}
