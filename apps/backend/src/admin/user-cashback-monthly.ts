/**
 * Admin per-user cashback-monthly aggregate (#633).
 *
 * `GET /api/admin/users/:userId/cashback-monthly` — last 12 calendar
 * months of cashback emissions for a single user, grouped by
 * `(month, currency)`. The user-scoped sibling of:
 *   - `/api/admin/cashback-monthly` (fleet-wide, ADR 009/015)
 *   - `/api/users/me/cashback-monthly` (user-facing self-view)
 *
 * Powers a 12-month trend chart on `/admin/users/:userId` so
 * support can see a user's cashback-earning trajectory alongside
 * the flywheel chip + cashback-summary without paging through the
 * full credit-transactions ledger.
 *
 * Invariants match the fleet sibling:
 *   - Fixed 12-month window (current UTC month + previous 11)
 *   - Filtered to `type='cashback'`
 *   - Oldest-first ordering for left-to-right chart rendering
 *   - One entry per (month, currency)
 *   - bigint-as-string wire format
 *
 * Zero-volume users return empty `entries` — not 404. A new user
 * with no cashback yet is a valid case; the chart component
 * renders the neutral empty-state line. 404 is reserved for
 * "userId doesn't exist".
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditTransactions, users } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-user-cashback-monthly' });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminUserCashbackMonthlyEntry {
  /** "YYYY-MM" in UTC. */
  month: string;
  currency: string;
  /** bigint-as-string, minor units. */
  cashbackMinor: string;
}

export interface AdminUserCashbackMonthlyResponse {
  userId: string;
  entries: AdminUserCashbackMonthlyEntry[];
}

interface AggRow {
  month: string | Date;
  currency: string;
  cashback_minor: string | number | bigint;
}

function formatMonth(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function toStringBigint(value: string | number | bigint): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Math.trunc(value).toString();
  return value;
}

export async function adminUserCashbackMonthlyHandler(c: Context): Promise<Response> {
  const userId = c.req.param('userId');
  if (userId === undefined || userId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId is required' }, 400);
  }
  if (!UUID_RE.test(userId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a uuid' }, 400);
  }

  try {
    // A separate existence check keeps 404 distinguishable from
    // "user exists but hasn't earned any cashback in the last 12
    // months" (which returns 200 with empty entries). Without this
    // probe a deleted-user lookup would masquerade as zero
    // activity and hide the bug.
    const existsRows = await db.execute<{ id: string }>(sql`
      SELECT id FROM ${users} WHERE id = ${userId} LIMIT 1
    `);
    const existsList = Array.isArray(existsRows)
      ? (existsRows as unknown as Array<{ id: string }>)
      : ((existsRows as unknown as { rows?: Array<{ id: string }> }).rows ?? []);
    if (existsList.length === 0) {
      return c.json({ code: 'NOT_FOUND', message: 'User not found' }, 404);
    }

    const result = await db.execute(sql`
      SELECT
        DATE_TRUNC('month', ${creditTransactions.createdAt} AT TIME ZONE 'UTC') AS month,
        ${creditTransactions.currency}                                           AS currency,
        COALESCE(SUM(${creditTransactions.amountMinor}), 0)::bigint              AS cashback_minor
      FROM ${creditTransactions}
      WHERE ${creditTransactions.userId} = ${userId}
        AND ${creditTransactions.type} = 'cashback'
        AND ${creditTransactions.createdAt} >= DATE_TRUNC('month', NOW() AT TIME ZONE 'UTC') - INTERVAL '11 months'
      GROUP BY month, currency
      ORDER BY month ASC, currency ASC
    `);

    const raw = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const entries: AdminUserCashbackMonthlyEntry[] = raw.map((r) => ({
      month: formatMonth(r.month),
      currency: r.currency,
      cashbackMinor: toStringBigint(r.cashback_minor),
    }));

    return c.json<AdminUserCashbackMonthlyResponse>({ userId, entries });
  } catch (err) {
    log.error({ err, userId }, 'Admin user cashback-monthly query failed');
    return c.json(
      { code: 'INTERNAL_ERROR', message: 'Failed to compute user cashback-monthly' },
      500,
    );
  }
}
