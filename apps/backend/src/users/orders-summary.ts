/**
 * User orders summary (ADR 010 / 015).
 *
 * `GET /api/users/me/orders/summary` — compact 5-number header the
 * `/orders` page renders above the paginated list. Companion to
 * `/api/users/me/cashback-summary` for the cashback side.
 *
 * Shape:
 *   { currency, totalOrders, fulfilledCount, pendingCount,
 *     failedCount, totalSpentMinor }
 *
 * Bucket semantics:
 *   - `pendingCount` = `pending_payment` + `paid` + `procuring`.
 *     These three states all read as "in flight" from the user's
 *     perspective — the UI chip just says "processing".
 *   - `failedCount` = `failed` + `expired`. Both are "didn't succeed"
 *     from the user's perspective; expired is the payment-watcher
 *     timing out, failed is the procurement / refund path.
 *   - `totalSpentMinor` is `SUM(charge_minor)` filtered to
 *     `state = 'fulfilled'`. Pending / failed orders don't count
 *     toward lifetime spend; the number should match what the user
 *     actually paid CTX for.
 *
 * Home-currency locked: `WHERE charge_currency = user.homeCurrency`.
 * Cross-currency detail (rare, support-mediated — user flipped region)
 * stays admin-only; the user-facing page shows their own currency.
 *
 * Single query with FILTER-ed COUNT + SUM — one round-trip, no N+1.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import type { User } from '../db/users.js';
import { decodeJwtPayload } from '../auth/jwt.js';
import { upsertUserFromCtx, getUserById } from '../db/users.js';
import type { LoopAuthContext } from '../auth/handler.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'user-orders-summary' });

export interface UserOrdersSummary {
  currency: string;
  totalOrders: number;
  fulfilledCount: number;
  /** `pending_payment` + `paid` + `procuring` — all "in flight" states. */
  pendingCount: number;
  /** `failed` + `expired` — both "didn't succeed". */
  failedCount: number;
  /** Sum of `charge_minor` across fulfilled orders only. bigint-as-string. */
  totalSpentMinor: string;
}

interface SummaryRow extends Record<string, unknown> {
  totalOrders: string | number | null;
  fulfilledCount: string | number | null;
  pendingCount: string | number | null;
  failedCount: string | number | null;
  totalSpentMinor: string | number | bigint | null;
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

export async function getUserOrdersSummaryHandler(c: Context): Promise<Response> {
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
    const result = await db.execute<SummaryRow>(sql`
      SELECT
        COUNT(*)::int AS "totalOrders",
        COUNT(*) FILTER (WHERE ${orders.state} = 'fulfilled')::int AS "fulfilledCount",
        COUNT(*) FILTER (
          WHERE ${orders.state} IN ('pending_payment', 'paid', 'procuring')
        )::int AS "pendingCount",
        COUNT(*) FILTER (
          WHERE ${orders.state} IN ('failed', 'expired')
        )::int AS "failedCount",
        COALESCE(
          SUM(${orders.chargeMinor}) FILTER (WHERE ${orders.state} = 'fulfilled'),
          0
        )::bigint AS "totalSpentMinor"
      FROM ${orders}
      WHERE ${orders.userId} = ${user.id}
        AND ${orders.chargeCurrency} = ${user.homeCurrency}
    `);
    const rows: SummaryRow[] = Array.isArray(result)
      ? (result as SummaryRow[])
      : ((result as { rows?: SummaryRow[] }).rows ?? []);
    const row = rows[0];

    return c.json<UserOrdersSummary>({
      currency: user.homeCurrency,
      totalOrders: toNumber(row?.totalOrders ?? 0),
      fulfilledCount: toNumber(row?.fulfilledCount ?? 0),
      pendingCount: toNumber(row?.pendingCount ?? 0),
      failedCount: toNumber(row?.failedCount ?? 0),
      totalSpentMinor: toStringBigint(row?.totalSpentMinor ?? null),
    });
  } catch (err) {
    log.error({ err }, 'Orders-summary query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load orders summary' }, 500);
  }
}
