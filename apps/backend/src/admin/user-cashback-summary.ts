/**
 * Admin per-user cashback-summary (ADR 009 / 011 / 015).
 *
 * `GET /api/admin/users/:userId/cashback-summary` — the admin-scoped
 * mirror of the user-facing `/api/users/me/cashback-summary`: lifetime
 * cashback earned + cashback earned since the start of the current
 * UTC calendar month, both scoped to the target user and their
 * current `home_currency`.
 *
 * Powers a compact headline on `/admin/users/:userId` so ops can
 * gauge a user's cashback trajectory without paging through the full
 * credit-transactions ledger. Complements the existing drill-downs:
 *   - /credits                — current per-currency balance
 *   - /credit-transactions    — full ledger feed
 *   - /cashback-by-merchant   — where cashback is coming from
 *   - /cashback-summary       ← scalar headline (this handler)
 *
 * Single query: a LEFT JOIN `users → credit_transactions` so a user
 * with zero cashback still returns a row (currency + zeroed totals).
 * An empty result means the user id doesn't exist → 404, so ops
 * can distinguish "user not found" from "user has never earned
 * cashback" without a second round-trip.
 */
import type { Context } from 'hono';
import { UUID_RE } from '../uuid.js';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditTransactions, users } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-user-cashback-summary' });

export interface AdminUserCashbackSummary {
  userId: string;
  /** Target user's current `home_currency` — the bucket totals are scoped to. */
  currency: string;
  /** All-time cashback earned in `currency`. bigint-as-string. */
  lifetimeMinor: string;
  /** Cashback earned since 00:00 UTC on the 1st of the current month. */
  thisMonthMinor: string;
}

interface DbRow extends Record<string, unknown> {
  currency: string;
  lifetimeMinor: string | number | bigint | null;
  thisMonthMinor: string | number | bigint | null;
}

export async function adminUserCashbackSummaryHandler(c: Context): Promise<Response> {
  const userId = c.req.param('userId');
  if (userId === undefined || userId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId is required' }, 400);
  }
  if (!UUID_RE.test(userId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a uuid' }, 400);
  }

  try {
    const result = await db.execute<DbRow>(sql`
      SELECT
        u.home_currency AS "currency",
        COALESCE(SUM(${creditTransactions.amountMinor}), 0)::bigint AS "lifetimeMinor",
        COALESCE(
          SUM(${creditTransactions.amountMinor}) FILTER (
            WHERE ${creditTransactions.createdAt}
              >= DATE_TRUNC('month', NOW() AT TIME ZONE 'UTC')
          ),
          0
        )::bigint AS "thisMonthMinor"
      FROM ${users} u
      LEFT JOIN ${creditTransactions} ON
        ${creditTransactions.userId} = u.id
        AND ${creditTransactions.type} = 'cashback'
        AND ${creditTransactions.currency} = u.home_currency
      WHERE u.id = ${userId}
      GROUP BY u.home_currency
    `);
    const rows: DbRow[] = Array.isArray(result)
      ? (result as DbRow[])
      : ((result as { rows?: DbRow[] }).rows ?? []);
    const row = rows[0];
    if (row === undefined) {
      return c.json({ code: 'NOT_FOUND', message: 'User not found' }, 404);
    }

    return c.json<AdminUserCashbackSummary>({
      userId,
      currency: row.currency,
      lifetimeMinor: (row.lifetimeMinor ?? '0').toString(),
      thisMonthMinor: (row.thisMonthMinor ?? '0').toString(),
    });
  } catch (err) {
    log.error({ err, userId }, 'Admin user cashback-summary query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load user cashback summary' }, 500);
  }
}
