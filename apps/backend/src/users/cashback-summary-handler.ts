/**
 * Caller-scoped cashback-summary handler (ADR 009 / 015).
 *
 * Lifted out of `apps/backend/src/users/handler.ts`. One handler
 * that backs the compact two-number cashback headline used on the
 * /home and /settings/cashback pages — same route the openapi spec
 * splits into `./openapi/users-cashback-drill.ts` (#1181):
 *
 *   - GET /api/users/me/cashback-summary → getCashbackSummaryHandler
 *
 * Two locally-scoped types travel with the slice:
 *   - exported `UserCashbackSummary`
 *   - private `CashbackSummaryRow` (the postgres-js shape from the
 *     conditional-SUM query)
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditTransactions } from '../db/schema.js';
import { resolveLoopAuthenticatedUser } from '../auth/authenticated-user.js';
import { type User } from '../db/users.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'users' });

async function resolveCallingUser(c: Context): Promise<User | null> {
  return await resolveLoopAuthenticatedUser(c);
}

/**
 * `GET /api/users/me/cashback-summary` — compact two-number summary
 * the home / cashback pages use for a "£42 lifetime · £3.20 this
 * month" headline. Avoids paging the whole `credit_transactions`
 * ledger when the UI only wants totals.
 *
 * Both totals are filtered to `type='cashback'` so they reflect what
 * the user actually *earned* — spend / adjustment / withdrawal don't
 * belong in an earnings summary. Currency comes from the user's
 * current `home_currency`; we don't cross-currency-sum. A user who
 * has moved regions (rare, support-mediated) sees only home-currency
 * earnings here; the admin ledger view has the cross-currency detail.
 *
 * Single query with two conditional SUMs — one round-trip.
 */
export interface UserCashbackSummary {
  currency: string;
  /** All-time cashback earned in `currency`, bigint-safe string. */
  lifetimeMinor: string;
  /**
   * Cashback earned since the start of the current UTC calendar
   * month. Resets at 00:00 UTC on the 1st.
   */
  thisMonthMinor: string;
}

interface CashbackSummaryRow extends Record<string, unknown> {
  lifetimeMinor: string | null;
  thisMonthMinor: string | null;
}

export async function getCashbackSummaryHandler(c: Context): Promise<Response> {
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
    const result = await db.execute<CashbackSummaryRow>(sql`
      SELECT
        COALESCE(SUM(${creditTransactions.amountMinor}), 0)::bigint AS "lifetimeMinor",
        COALESCE(
          SUM(${creditTransactions.amountMinor}) FILTER (
            WHERE ${creditTransactions.createdAt}
              >= DATE_TRUNC('month', NOW() AT TIME ZONE 'UTC')
          ),
          0
        )::bigint AS "thisMonthMinor"
      FROM ${creditTransactions}
      WHERE ${creditTransactions.userId} = ${user.id}
        AND ${creditTransactions.type} = 'cashback'
        AND ${creditTransactions.currency} = ${user.homeCurrency}
    `);
    const rows: CashbackSummaryRow[] = Array.isArray(result)
      ? (result as CashbackSummaryRow[])
      : ((result as { rows?: CashbackSummaryRow[] }).rows ?? []);
    const row = rows[0];

    return c.json<UserCashbackSummary>({
      currency: user.homeCurrency,
      lifetimeMinor: (row?.lifetimeMinor ?? '0').toString(),
      thisMonthMinor: (row?.thisMonthMinor ?? '0').toString(),
    });
  } catch (err) {
    log.error({ err }, 'Cashback-summary query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load cashback summary' }, 500);
  }
}
