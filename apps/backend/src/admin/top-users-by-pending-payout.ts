/**
 * Admin top-users-by-pending-payout leaderboard (ADR 015 / 016).
 *
 * `GET /api/admin/users/top-by-pending-payout?limit=20` — users
 * ordered by the total stroops they're currently owed across
 * `pending` + `submitted` payouts, grouped by `(user, asset)`.
 *
 * Ops uses this to prioritise operator funding: "who's owed the
 * most USDLOOP right now?" is the first question when deciding
 * whether to top up an operator before the reserve runs dry.
 * Complements `/api/admin/users/top-by-cashback` (#429), which
 * ranks by lifetime *earnings* rather than current *debt*.
 *
 * Single GROUP BY over `(user_id, email, asset_code)` joined to
 * `users`. `confirmed` and `failed` rows are excluded — those
 * aren't obligations we still owe.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pendingPayouts, users } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-top-users-by-pending-payout' });

export interface AdminTopPendingPayoutEntry {
  userId: string;
  email: string;
  assetCode: string;
  /** Total stroops owed across pending + submitted payouts, bigint-safe. */
  totalStroops: string;
  /** Number of open payout rows feeding the total. */
  payoutCount: number;
}

export interface AdminTopUsersByPendingPayoutResponse {
  /** Highest-owed first. Capped by the `?limit=` query param. */
  entries: AdminTopPendingPayoutEntry[];
}

interface Row extends Record<string, unknown> {
  userId: string;
  email: string;
  assetCode: string;
  totalStroops: string | null;
  payoutCount: string | number;
}

export async function adminTopUsersByPendingPayoutHandler(c: Context): Promise<Response> {
  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? '20', 10);
  // Floor 1 (zero would return nothing), cap 100 (beyond that we'd be
  // dumping the whole backlog; use the list endpoint for that).
  const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? 20 : parsedLimit, 1), 100);

  try {
    const result = await db.execute<Row>(sql`
      SELECT
        ${pendingPayouts.userId} AS "userId",
        ${users.email} AS email,
        ${pendingPayouts.assetCode} AS "assetCode",
        COALESCE(SUM(${pendingPayouts.amountStroops}), 0)::bigint AS "totalStroops",
        COUNT(*)::bigint AS "payoutCount"
      FROM ${pendingPayouts}
      JOIN ${users} ON ${users.id} = ${pendingPayouts.userId}
      WHERE ${pendingPayouts.state} IN ('pending', 'submitted')
      GROUP BY ${pendingPayouts.userId}, ${users.email}, ${pendingPayouts.assetCode}
      ORDER BY COALESCE(SUM(${pendingPayouts.amountStroops}), 0) DESC
      LIMIT ${limit}
    `);
    const rows: Row[] = Array.isArray(result)
      ? (result as Row[])
      : ((result as { rows?: Row[] }).rows ?? []);

    const entries: AdminTopPendingPayoutEntry[] = rows.map((row) => ({
      userId: row.userId,
      email: row.email,
      assetCode: row.assetCode,
      totalStroops: (row.totalStroops ?? '0').toString(),
      payoutCount: Number(row.payoutCount),
    }));
    return c.json<AdminTopUsersByPendingPayoutResponse>({ entries });
  } catch (err) {
    log.error({ err }, 'Admin top-users-by-pending-payout failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load ranking' }, 500);
  }
}
