/**
 * Admin top-users-by-cashback leaderboard (ADR 009 / 015).
 *
 * `GET /api/admin/users/top-by-cashback?limit=20` — single GROUP BY
 * over `credit_transactions` joined to `users`, returning the users
 * who've earned the most lifetime cashback. Grouped by
 * `(user_id, currency)` so multi-region users don't have rows silently
 * summed across currencies they never see together.
 *
 * Admins use this to spot power users (referral candidates, support
 * escalation priorities) and to validate the cashback program is
 * actually paying out to real users at the expected scale.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditTransactions, users } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-top-users' });

export interface AdminTopUserEntry {
  userId: string;
  email: string;
  currency: string;
  /** Lifetime cashback in that currency, minor units, bigint-safe. */
  cashbackMinor: string;
  /** Number of individual cashback ledger events that fed into the total. */
  cashbackEvents: number;
}

export interface AdminTopUsersResponse {
  /** Highest-cashback first. Capped by the `?limit=` query param. */
  entries: AdminTopUserEntry[];
}

interface TopUserRow extends Record<string, unknown> {
  userId: string;
  email: string;
  currency: string;
  cashbackMinor: string | null;
  cashbackEvents: string | number;
}

export async function adminTopUsersByCashbackHandler(c: Context): Promise<Response> {
  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? '20', 10);
  // Floor 1, cap 100 — an admin dashboard tile only needs the top slice.
  const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? 20 : parsedLimit, 1), 100);

  try {
    const result = await db.execute<TopUserRow>(sql`
      SELECT
        ${creditTransactions.userId} AS "userId",
        ${users.email} AS email,
        ${creditTransactions.currency} AS currency,
        COALESCE(SUM(${creditTransactions.amountMinor}), 0)::bigint AS "cashbackMinor",
        COUNT(*)::bigint AS "cashbackEvents"
      FROM ${creditTransactions}
      JOIN ${users} ON ${users.id} = ${creditTransactions.userId}
      WHERE ${creditTransactions.type} = 'cashback'
      GROUP BY ${creditTransactions.userId}, ${users.email}, ${creditTransactions.currency}
      ORDER BY COALESCE(SUM(${creditTransactions.amountMinor}), 0) DESC
      LIMIT ${limit}
    `);
    const rows: TopUserRow[] = Array.isArray(result)
      ? (result as TopUserRow[])
      : ((result as { rows?: TopUserRow[] }).rows ?? []);

    const entries: AdminTopUserEntry[] = rows.map((row) => ({
      userId: row.userId,
      email: row.email,
      currency: row.currency,
      cashbackMinor: (row.cashbackMinor ?? '0').toString(),
      cashbackEvents: Number(row.cashbackEvents),
    }));
    return c.json<AdminTopUsersResponse>({ entries });
  } catch (err) {
    log.error({ err }, 'Admin top-users-by-cashback query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load top users' }, 500);
  }
}
