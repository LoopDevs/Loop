/**
 * Admin top-users by cashback earned (ADR 009 / 015).
 *
 * `GET /api/admin/top-users` — ranked list of users with the most
 * cashback accrued in a time window. Two shoulders use this:
 *   - ops recognition ("top earners this month")
 *   - fraud / concentration signal ("one user accounts for 70%
 *     of cashback this week — why?")
 *
 * Groups by (user, currency) because fleet-wide totals across
 * currencies aren't meaningful. Default window 30 days, capped
 * at 366. Limit clamped 1..100, default 20 — ranked leaderboards
 * are typically rendered at top-10 or top-20.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditTransactions, users } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-top-users' });

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface TopUserRow {
  userId: string;
  email: string;
  currency: string;
  /** Accrual count in the window. */
  count: number;
  /** Sum of positive cashback amount_minor for this (user, currency). bigint-as-string. */
  amountMinor: string;
}

export interface TopUsersResponse {
  since: string;
  rows: TopUserRow[];
}

interface AggRow {
  user_id: string;
  email: string;
  currency: string;
  count: string | number;
  amount_minor: string | number | bigint;
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

export async function adminTopUsersHandler(c: Context): Promise<Response> {
  const sinceRaw = c.req.query('since');
  let since: Date;
  if (sinceRaw !== undefined && sinceRaw.length > 0) {
    const d = new Date(sinceRaw);
    if (Number.isNaN(d.getTime())) {
      return c.json(
        { code: 'VALIDATION_ERROR', message: 'since must be an ISO-8601 timestamp' },
        400,
      );
    }
    since = d;
  } else {
    since = new Date(Date.now() - DEFAULT_WINDOW_MS);
  }
  if (Date.now() - since.getTime() > MAX_WINDOW_MS) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'since cannot be more than 366 days ago' },
      400,
    );
  }

  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? `${DEFAULT_LIMIT}`, 10);
  const limit = Math.min(
    Math.max(Number.isNaN(parsedLimit) ? DEFAULT_LIMIT : parsedLimit, 1),
    MAX_LIMIT,
  );

  try {
    const result = await db.execute(sql`
      SELECT
        ct.user_id AS user_id,
        u.email    AS email,
        ct.currency,
        COUNT(*)::bigint AS count,
        COALESCE(SUM(ct.amount_minor), 0)::bigint AS amount_minor
      FROM ${creditTransactions} ct
      JOIN ${users} u ON u.id = ct.user_id
      WHERE ct.type = 'cashback'
        AND ct.created_at >= ${since}
      GROUP BY ct.user_id, u.email, ct.currency
      ORDER BY amount_minor DESC, count DESC
      LIMIT ${limit}
    `);

    const rows = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const body: TopUsersResponse = {
      since: since.toISOString(),
      rows: rows.map((r) => ({
        userId: r.user_id,
        email: r.email,
        currency: r.currency,
        count: toNumber(r.count),
        amountMinor: toStringBigint(r.amount_minor),
      })),
    };
    return c.json(body);
  } catch (err) {
    log.error({ err }, 'Admin top-users query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to compute top users' }, 500);
  }
}
