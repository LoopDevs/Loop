/**
 * Admin per-user flywheel stats (ADR 011 / 015).
 *
 * `GET /api/admin/users/:userId/flywheel-stats` — admin-scoped
 * mirror of `/api/users/me/flywheel-stats`. Returns the target
 * user's recycled-vs-total counts: how many fulfilled orders they
 * paid with `payment_method = 'loop_asset'` (i.e. spent their
 * previously-earned cashback on a new gift card), against the
 * total-fulfilled denominator.
 *
 * Powers a compact chip on `/admin/users/:userId`. Complements the
 * existing admin scalars:
 *   - `/cashback-summary`     (lifetime + this-month earned)
 *   - `/cashback-by-merchant` (where did the cashback come from)
 *   - `/flywheel-stats`       (did they spend it back, on what rail)
 *
 * Shape / scoping is identical to the user-facing endpoint — the
 * only difference is the caller bypasses the resolveCallingUser
 * step and takes the userId from the path param. Scoped to the
 * target user's current home_currency so numerator + denominator
 * share a denomination (the same reason the user-facing endpoint
 * does the same).
 *
 * 404 when the user doesn't exist; empty result → zeroed response
 * for a user with no fulfilled orders.
 */
import type { Context } from 'hono';
import { UUID_RE } from '../uuid.js';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders, users } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-user-flywheel-stats' });

export interface AdminUserFlywheelStats {
  userId: string;
  /** Target user's current `home_currency`. */
  currency: string;
  recycledOrderCount: number;
  /** SUM(charge_minor) over loop_asset orders. bigint-as-string. */
  recycledChargeMinor: string;
  totalFulfilledCount: number;
  /** SUM(charge_minor) over every fulfilled order in `home_currency`. bigint-as-string. */
  totalFulfilledChargeMinor: string;
}

interface AggRow extends Record<string, unknown> {
  currency: string;
  recycledOrderCount: string | number | null;
  recycledChargeMinor: string | number | bigint | null;
  totalFulfilledCount: string | number | null;
  totalFulfilledChargeMinor: string | number | bigint | null;
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

export async function adminUserFlywheelStatsHandler(c: Context): Promise<Response> {
  const userId = c.req.param('userId');
  if (userId === undefined || userId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId is required' }, 400);
  }
  if (!UUID_RE.test(userId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a uuid' }, 400);
  }

  try {
    // LEFT JOIN users → orders so a user with zero fulfilled orders
    // still returns a row (with zeroed counts) rather than collapsing
    // into "user not found" territory. An empty result means the
    // user id doesn't exist → 404.
    const result = await db.execute<AggRow>(sql`
      SELECT
        u.home_currency AS "currency",
        COUNT(*) FILTER (
          WHERE ${orders.paymentMethod} = 'loop_asset'
            AND ${orders.state} = 'fulfilled'
            AND ${orders.chargeCurrency} = u.home_currency
        )::int AS "recycledOrderCount",
        COALESCE(
          SUM(${orders.chargeMinor}) FILTER (
            WHERE ${orders.paymentMethod} = 'loop_asset'
              AND ${orders.state} = 'fulfilled'
              AND ${orders.chargeCurrency} = u.home_currency
          ),
          0
        )::bigint AS "recycledChargeMinor",
        COUNT(*) FILTER (
          WHERE ${orders.state} = 'fulfilled'
            AND ${orders.chargeCurrency} = u.home_currency
        )::int AS "totalFulfilledCount",
        COALESCE(
          SUM(${orders.chargeMinor}) FILTER (
            WHERE ${orders.state} = 'fulfilled'
              AND ${orders.chargeCurrency} = u.home_currency
          ),
          0
        )::bigint AS "totalFulfilledChargeMinor"
      FROM ${users} u
      LEFT JOIN ${orders} ON ${orders.userId} = u.id
      WHERE u.id = ${userId}
      GROUP BY u.home_currency
    `);
    const rows: AggRow[] = Array.isArray(result)
      ? (result as AggRow[])
      : ((result as { rows?: AggRow[] }).rows ?? []);
    const row = rows[0];
    if (row === undefined) {
      return c.json({ code: 'NOT_FOUND', message: 'User not found' }, 404);
    }

    return c.json<AdminUserFlywheelStats>({
      userId,
      currency: row.currency,
      recycledOrderCount: toNumber(row.recycledOrderCount ?? 0),
      recycledChargeMinor: toStringBigint(row.recycledChargeMinor ?? 0),
      totalFulfilledCount: toNumber(row.totalFulfilledCount ?? 0),
      totalFulfilledChargeMinor: toStringBigint(row.totalFulfilledChargeMinor ?? 0),
    });
  } catch (err) {
    log.error({ err, userId }, 'Admin user-flywheel-stats query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load user flywheel stats' }, 500);
  }
}
