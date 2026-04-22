/**
 * Admin per-user payment-method share (#628 follow-up).
 *
 * `GET /api/admin/users/:userId/payment-method-share?state=fulfilled` —
 * user-scoped mirror of `/api/admin/orders/payment-method-share`
 * and `/api/admin/merchants/:merchantId/payment-method-share`
 * (#627). Groups one user's orders by payment rail with a
 * zero-filled `byMethod` record.
 *
 * Drives a "rail mix" card on the user drill-down, mirroring the
 * card that already exists on the merchant drill. Ops support use:
 * "this user always pays with LOOP asset" → a stuck loop_asset
 * order on their account is a high-impact flag; "this user has
 * never touched loop_asset" → the flywheel hasn't started for
 * them yet.
 *
 * Validates userId as a UUID (matches the convention of every
 * other per-user admin endpoint — malformed input never reaches
 * the driver). Zero-volume users return a zeroed response, not
 * 404 — a newly-created account with no orders is valid.
 */
import type { Context } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import {
  ORDER_PAYMENT_METHODS,
  ORDER_STATES,
  type OrderPaymentMethod,
  type OrderState,
} from '@loop/shared';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-user-payment-method-share' });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface UserPaymentMethodBucket {
  orderCount: number;
  /** SUM(charge_minor) for this (user, state, method) bucket. bigint-as-string. */
  chargeMinor: string;
}

export interface UserPaymentMethodShareResponse {
  userId: string;
  state: OrderState;
  totalOrders: number;
  byMethod: Record<OrderPaymentMethod, UserPaymentMethodBucket>;
}

interface AggRow {
  payment_method: string;
  order_count: string | number | bigint;
  charge_minor: string | number | bigint;
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

export async function adminUserPaymentMethodShareHandler(c: Context): Promise<Response> {
  const userId = c.req.param('userId');
  if (userId === undefined || userId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId is required' }, 400);
  }
  if (!UUID_RE.test(userId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a uuid' }, 400);
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
      WHERE ${and(eq(orders.userId, userId), eq(orders.state, state))}
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
          { paymentMethod: r.payment_method, userId },
          'Unknown payment_method in orders aggregate — dropping from share response',
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
      userId,
      state,
      totalOrders,
      byMethod,
    });
  } catch (err) {
    log.error({ err, userId }, 'Admin user payment-method-share query failed');
    return c.json(
      { code: 'INTERNAL_ERROR', message: 'Failed to compute user payment-method share' },
      500,
    );
  }
}
