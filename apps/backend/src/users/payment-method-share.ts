/**
 * User payment-method share (#643).
 *
 * `GET /api/users/me/payment-method-share?state=fulfilled` — the
 * caller's own rail mix. User-facing self-view of the admin
 * per-user rail-mix endpoint (#629): same shape, same zero-fill,
 * but keyed on the auth context rather than a path param.
 *
 * Powers a "your rail mix" card on /settings/cashback so the user
 * can see their own LOOP-asset recycling share and nudge toward
 * the compounding-cashback behaviour ADR 015 is built around — if
 * they see a low LOOP share, the app can surface a hint to choose
 * LOOP at next checkout.
 *
 * Invariants match the admin variants:
 *   - Default ?state=fulfilled
 *   - Zero-fill every ORDER_PAYMENT_METHODS value
 *   - Unknown payment_method values dropped with a log-warn
 *   - bigint-as-string on chargeMinor
 *
 * Home-currency locked: only orders in the caller's current
 * home_currency count — matches the user-facing flywheel-stats
 * endpoint convention. If a GBP user bought a USD card (charge
 * currency USD) the order won't appear here; it would skew the
 * "share of my home-currency spend" framing the UI shows.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import {
  ORDER_PAYMENT_METHODS,
  ORDER_STATES,
  type OrderPaymentMethod,
  type OrderState,
} from '@loop/shared';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import type { User } from '../db/users.js';
import { resolveLoopAuthenticatedUser } from '../auth/authenticated-user.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'user-payment-method-share' });

export interface UserPaymentMethodBucket {
  orderCount: number;
  /** SUM(charge_minor) for this (state, method) bucket. bigint-as-string. */
  chargeMinor: string;
}

export interface UserPaymentMethodShareResponse {
  currency: string;
  state: OrderState;
  totalOrders: number;
  byMethod: Record<OrderPaymentMethod, UserPaymentMethodBucket>;
}

interface AggRow {
  payment_method: string;
  order_count: string | number | bigint;
  charge_minor: string | number | bigint;
}

/**
 * A2-550 / A2-551 fix: identity resolution now requires a verified
 * Loop-signed token. See `apps/backend/src/auth/authenticated-user.ts`.
 */
async function resolveCallingUser(c: Context): Promise<User | null> {
  return await resolveLoopAuthenticatedUser(c);
}

function toNumber(value: string | number | bigint): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return Number.parseInt(value, 10);
}

function toStringBigint(value: string | number | bigint): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Math.trunc(value).toString();
  return value;
}

function zeroFill(): Record<OrderPaymentMethod, UserPaymentMethodBucket> {
  const out = {} as Record<OrderPaymentMethod, UserPaymentMethodBucket>;
  for (const m of ORDER_PAYMENT_METHODS) {
    out[m] = { orderCount: 0, chargeMinor: '0' };
  }
  return out;
}

export async function getUserPaymentMethodShareHandler(c: Context): Promise<Response> {
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

  const stateRaw = c.req.query('state') ?? 'fulfilled';
  if (!(ORDER_STATES as readonly string[]).includes(stateRaw)) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: `state must be one of: ${ORDER_STATES.join(', ')}`,
      },
      400,
    );
  }
  const state = stateRaw as OrderState;

  try {
    const result = await db.execute(sql`
      SELECT
        ${orders.paymentMethod}                         AS payment_method,
        COUNT(*)::bigint                                AS order_count,
        COALESCE(SUM(${orders.chargeMinor}), 0)::bigint AS charge_minor
      FROM ${orders}
      WHERE ${orders.userId} = ${user.id}
        AND ${orders.state} = ${state}
        AND ${orders.chargeCurrency} = ${user.homeCurrency}
      GROUP BY ${orders.paymentMethod}
    `);

    const rawRows = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const byMethod = zeroFill();
    let totalOrders = 0;
    for (const r of rawRows) {
      if (!(ORDER_PAYMENT_METHODS as readonly string[]).includes(r.payment_method)) {
        log.warn(
          { paymentMethod: r.payment_method, userId: user.id },
          'Unknown payment_method in user orders aggregate — dropping from share response',
        );
        continue;
      }
      const method = r.payment_method as OrderPaymentMethod;
      const count = toNumber(r.order_count);
      byMethod[method] = {
        orderCount: count,
        chargeMinor: toStringBigint(r.charge_minor),
      };
      totalOrders += count;
    }

    return c.json<UserPaymentMethodShareResponse>({
      currency: user.homeCurrency,
      state,
      totalOrders,
      byMethod,
    });
  } catch (err) {
    log.error({ err, userId: user.id }, 'User payment-method-share query failed');
    return c.json(
      { code: 'INTERNAL_ERROR', message: 'Failed to compute payment-method share' },
      500,
    );
  }
}
