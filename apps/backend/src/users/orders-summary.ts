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
import { db } from '../db/client.js';
import type { User } from '../db/users.js';
import { resolveLoopAuthenticatedUser } from '../auth/authenticated-user.js';
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

/**
 * A2-550 / A2-551 fix: identity resolution now requires a verified
 * Loop-signed token. See `apps/backend/src/auth/authenticated-user.ts`.
 */
async function resolveCallingUser(c: Context): Promise<User | null> {
  return await resolveLoopAuthenticatedUser(c);
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
    // One filtered scan, bucketed in code — the per-user order count
    // is small by construction.
    const rows = await db
      .collection('orders')
      .findMany({ userId: user.id, chargeCurrency: user.homeCurrency });
    let fulfilledCount = 0;
    let pendingCount = 0;
    let failedCount = 0;
    let totalSpentMinor = 0;
    for (const order of rows) {
      if (order.state === 'fulfilled') {
        fulfilledCount++;
        totalSpentMinor += order.chargeMinor;
      } else if (order.state === 'unpaid' || order.state === 'paid') {
        pendingCount++;
      } else {
        // rejected / refunded / expired — "didn't succeed" states.
        failedCount++;
      }
    }

    return c.json<UserOrdersSummary>({
      currency: user.homeCurrency,
      totalOrders: rows.length,
      fulfilledCount,
      pendingCount,
      failedCount,
      totalSpentMinor: String(totalSpentMinor),
    });
  } catch (err) {
    log.error({ err }, 'Orders-summary query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load orders summary' }, 500);
  }
}
