/**
 * Admin top-users by pending-payout obligation (ADR 015 / 016).
 *
 * `GET /api/admin/users/top-by-pending-payout?limit=20` — ranked list
 * of users with the most in-flight (`state IN ('pending', 'submitted')`)
 * on-chain payout debt, grouped by `(user, asset)` so funding decisions
 * stay per-asset.
 *
 * Ops reads this before topping up an operator reserve: "who's owed
 * the most USDLOOP right now?" is the first question before a CTX
 * top-up. Complement to the lifetime-earnings `/api/admin/top-users`
 * endpoint — this one ranks by *current debt*, that one by
 * *historical earnings*.
 *
 * `failed` rows are deliberately excluded. They are still outstanding
 * obligations in a bookkeeping sense, but the admin panel's
 * `/admin/payouts?state=failed` is the right place to triage them:
 * once retried they transition back to `pending` and rejoin this
 * leaderboard automatically.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pendingPayouts, users } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-top-users-by-pending-payout' });

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface TopUserByPendingPayoutEntry {
  userId: string;
  email: string;
  /** LOOP asset code: USDLOOP / GBPLOOP / EURLOOP. */
  assetCode: string;
  /** Sum of `amount_stroops` for this (user, asset) across pending + submitted. bigint-as-string. */
  totalStroops: string;
  /** Number of payout rows contributing to `totalStroops`. */
  payoutCount: number;
}

export interface TopUsersByPendingPayoutResponse {
  entries: TopUserByPendingPayoutEntry[];
}

interface AggRow {
  user_id: string;
  email: string;
  asset_code: string;
  total_stroops: string | number | bigint;
  payout_count: string | number;
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

export async function adminTopUsersByPendingPayoutHandler(c: Context): Promise<Response> {
  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? `${DEFAULT_LIMIT}`, 10);
  const limit = Math.min(
    Math.max(Number.isNaN(parsedLimit) ? DEFAULT_LIMIT : parsedLimit, 1),
    MAX_LIMIT,
  );

  try {
    const result = await db.execute(sql`
      SELECT
        pp.user_id         AS user_id,
        u.email            AS email,
        pp.asset_code      AS asset_code,
        COALESCE(SUM(pp.amount_stroops), 0)::bigint AS total_stroops,
        COUNT(*)::bigint   AS payout_count
      FROM ${pendingPayouts} pp
      JOIN ${users} u ON u.id = pp.user_id
      WHERE pp.state IN ('pending', 'submitted')
      GROUP BY pp.user_id, u.email, pp.asset_code
      ORDER BY total_stroops DESC, payout_count DESC
      LIMIT ${limit}
    `);

    const rows = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const body: TopUsersByPendingPayoutResponse = {
      entries: rows.map((r) => ({
        userId: r.user_id,
        email: r.email,
        assetCode: r.asset_code,
        totalStroops: toStringBigint(r.total_stroops),
        payoutCount: toNumber(r.payout_count),
      })),
    };
    return c.json(body);
  } catch (err) {
    log.error({ err }, 'Admin top-users-by-pending-payout query failed');
    return c.json(
      {
        code: 'INTERNAL_ERROR',
        message: 'Failed to compute top users by pending payout',
      },
      500,
    );
  }
}
