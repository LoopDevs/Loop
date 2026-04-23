/**
 * User flywheel stats (ADR 015).
 *
 * `GET /api/users/me/flywheel-stats` — scalar summary of the caller's
 * personal cashback recycling: how many of their fulfilled orders
 * were paid with a LOOP asset (the rail that only holds their own
 * previously-earned cashback) and the total charge that moved
 * through it.
 *
 * Shape:
 *   { currency, recycledOrderCount, recycledChargeMinor,
 *     totalFulfilledCount, totalFulfilledChargeMinor }
 *
 * Powers a "£X recycled across Y orders" chip on the user's /orders
 * or /settings/cashback view. Framing: the user sees their own
 * participation in the ADR-015 flywheel — cashback credited on one
 * order was spent into a later order, closing the loop.
 *
 * Home-currency locked: only orders in the user's current
 * `home_currency` count. The loop_asset emitted for a user is tied
 * to their home currency (USDLOOP / GBPLOOP / EURLOOP), so the
 * denominator and numerator share a denomination.
 *
 * Single query with FILTER-ed COUNT + SUM — one round-trip, no N+1.
 * bigint-as-string on the wire for charge totals.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import type { User } from '../db/users.js';
import { resolveLoopAuthenticatedUser } from '../auth/authenticated-user.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'user-flywheel-stats' });

export interface UserFlywheelStats {
  /** The caller's current `home_currency` — the denomination both totals are scoped to. */
  currency: string;
  /** Fulfilled orders with `payment_method = 'loop_asset'`. */
  recycledOrderCount: number;
  /** SUM(charge_minor) over those orders. bigint-as-string. */
  recycledChargeMinor: string;
  /** Denominator: every fulfilled order in `home_currency`, regardless of rail. */
  totalFulfilledCount: number;
  /** SUM(charge_minor) over every fulfilled order in home_currency. bigint-as-string. */
  totalFulfilledChargeMinor: string;
}

interface AggRow extends Record<string, unknown> {
  recycledOrderCount: string | number | null;
  recycledChargeMinor: string | number | bigint | null;
  totalFulfilledCount: string | number | null;
  totalFulfilledChargeMinor: string | number | bigint | null;
}

/**
 * A2-550 / A2-551 fix: identity resolution now requires a verified
 * Loop-signed token. See `apps/backend/src/auth/authenticated-user.ts`.
 */
async function resolveCallingUser(c: Context): Promise<User | null> {
  return await resolveLoopAuthenticatedUser(c);
}

function toNumber(value: string | number | null): number {
  if (value === null) return 0;
  if (typeof value === 'number') return value;
  return Number.parseInt(value, 10);
}

function toStringBigint(value: string | number | bigint | null): string {
  if (value === null) return '0';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Math.trunc(value).toString();
  return value;
}

export async function getUserFlywheelStatsHandler(c: Context): Promise<Response> {
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
    const result = await db.execute<AggRow>(sql`
      SELECT
        COUNT(*) FILTER (
          WHERE ${orders.paymentMethod} = 'loop_asset'
        )::int AS "recycledOrderCount",
        COALESCE(
          SUM(${orders.chargeMinor}) FILTER (
            WHERE ${orders.paymentMethod} = 'loop_asset'
          ),
          0
        )::bigint AS "recycledChargeMinor",
        COUNT(*)::int AS "totalFulfilledCount",
        COALESCE(SUM(${orders.chargeMinor}), 0)::bigint AS "totalFulfilledChargeMinor"
      FROM ${orders}
      WHERE ${orders.userId} = ${user.id}
        AND ${orders.state} = 'fulfilled'
        AND ${orders.chargeCurrency} = ${user.homeCurrency}
    `);
    const rows: AggRow[] = Array.isArray(result)
      ? (result as AggRow[])
      : ((result as { rows?: AggRow[] }).rows ?? []);
    const row = rows[0];

    return c.json<UserFlywheelStats>({
      currency: user.homeCurrency,
      recycledOrderCount: toNumber(row?.recycledOrderCount ?? 0),
      recycledChargeMinor: toStringBigint(row?.recycledChargeMinor ?? 0),
      totalFulfilledCount: toNumber(row?.totalFulfilledCount ?? 0),
      totalFulfilledChargeMinor: toStringBigint(row?.totalFulfilledChargeMinor ?? 0),
    });
  } catch (err) {
    log.error({ err }, 'Flywheel-stats query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to compute flywheel stats' }, 500);
  }
}
