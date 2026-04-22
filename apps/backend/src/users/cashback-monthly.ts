/**
 * User cashback-monthly aggregate (ADR 009 / 015).
 *
 * `GET /api/users/me/cashback-monthly` — last 12 calendar months of
 * cashback totals for the caller, grouped by `(month, currency)`.
 * Time-axis cousin to `/cashback-by-merchant` (the merchant-axis
 * view) — users care about "how does this month compare to last?"
 * more than about the raw ledger scroll, so this drives the
 * monthly-cashback bar chart on `/settings/cashback`.
 *
 * Shape:
 *   { entries: [{ month: "2026-04", currency: "GBP",
 *                 cashbackMinor: "1800" }, ...] }
 *
 * Invariants:
 *   - Fixed 12-month window (current UTC month + previous 11).
 *     Widening later is a non-breaking query change.
 *   - Filtered to `type='cashback'` — spend / withdrawal / adjustment
 *     don't belong in "what have I earned?".
 *   - Oldest-first ordering so the bar chart renders left-to-right
 *     without a client-side reverse.
 *   - Multi-currency safe: one entry per (month, currency) pair.
 *     Users who've moved regions get both currencies back.
 *   - Bigint-safe string for `cashbackMinor` — precision is preserved
 *     end-to-end, even for users whose fleet-wide lifetime summed
 *     past `Number.MAX_SAFE_INTEGER`.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditTransactions } from '../db/schema.js';
import type { User } from '../db/users.js';
import { decodeJwtPayload } from '../auth/jwt.js';
import { upsertUserFromCtx, getUserById } from '../db/users.js';
import type { LoopAuthContext } from '../auth/handler.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'user-cashback-monthly' });

export interface CashbackMonthlyEntry {
  /** "YYYY-MM" in UTC. */
  month: string;
  currency: string;
  /** bigint-as-string, minor units. */
  cashbackMinor: string;
}

export interface CashbackMonthlyResponse {
  entries: CashbackMonthlyEntry[];
}

interface AggRow {
  month: string | Date;
  currency: string;
  cashback_minor: string | number | bigint;
}

async function resolveCallingUser(c: Context): Promise<User | null> {
  const auth = c.get('auth') as LoopAuthContext | undefined;
  if (auth === undefined) return null;
  if (auth.kind === 'loop') {
    return await getUserById(auth.userId);
  }
  const claims = decodeJwtPayload(auth.bearerToken);
  if (claims === null) return null;
  return await upsertUserFromCtx({
    ctxUserId: claims.sub,
    email: typeof claims['email'] === 'string' ? claims['email'] : undefined,
  });
}

/**
 * Normalises the DB `month` column to a `"YYYY-MM"` string. Postgres
 * `date_trunc('month', ...)` returns a timestamp at 00:00:00 UTC of
 * the first-of-month; we slice instead of using `toLocaleString` so
 * the month name doesn't drift with the server's locale.
 */
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

export async function getCashbackMonthlyHandler(c: Context): Promise<Response> {
  let user: User | null;
  try {
    user = await resolveCallingUser(c);
  } catch (err) {
    log.error({ err }, 'Failed to resolve calling user');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to resolve user' }, 500);
  }
  if (user === null) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
  }

  try {
    // 12-month window anchored on the current UTC month. Cutoff is
    // the start of (now - 11 months), computed server-side via
    // `date_trunc` so month lengths stay correct without JS date
    // arithmetic.
    const result = await db.execute(sql`
      SELECT
        DATE_TRUNC('month', ${creditTransactions.createdAt} AT TIME ZONE 'UTC') AS month,
        ${creditTransactions.currency}                                           AS currency,
        COALESCE(SUM(${creditTransactions.amountMinor}), 0)::bigint              AS cashback_minor
      FROM ${creditTransactions}
      WHERE ${creditTransactions.userId} = ${user.id}
        AND ${creditTransactions.type}   = 'cashback'
        AND ${creditTransactions.createdAt} >= DATE_TRUNC('month', NOW() AT TIME ZONE 'UTC') - INTERVAL '11 months'
      GROUP BY month, currency
      ORDER BY month ASC, currency ASC
    `);

    const raw = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const entries: CashbackMonthlyEntry[] = raw.map((r) => ({
      month: formatMonth(r.month),
      currency: r.currency,
      cashbackMinor: toStringBigint(r.cashback_minor),
    }));

    return c.json<CashbackMonthlyResponse>({ entries });
  } catch (err) {
    log.error({ err }, 'cashback-monthly query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to compute cashback-monthly' }, 500);
  }
}
