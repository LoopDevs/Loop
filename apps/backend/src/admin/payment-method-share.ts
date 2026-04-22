/**
 * Admin payment-method share (ADR 010 / 015).
 *
 * `GET /api/admin/orders/payment-method-share?state=fulfilled` —
 * single GROUP BY over `orders.payment_method`, zero-filled across
 * every known method (`xlm`, `usdc`, `credit`, `loop_asset`).
 *
 * This is the **cashback-flywheel metric** for the cashback-app
 * pivot: ADR 010 / ADR 015 assume users will pay with `loop_asset`
 * (their on-ledger LOOP cashback balance) once they've earned any,
 * rather than topping up fresh XLM every time. A rising
 * `loop_asset` share is the signal the strategy is working — users
 * are recycling cashback into more orders.
 *
 * Shape:
 *   { state, totalOrders, byMethod: { <method>: { orderCount, chargeMinor } } }
 *
 * Invariants:
 *   - Default `?state=fulfilled` so `pending_payment` orders don't
 *     skew the mix while users are still on the checkout page.
 *     Admins tracking the in-flight picture can pass `paid` /
 *     `procuring` / `failed` / `expired`.
 *   - Every `ORDER_PAYMENT_METHODS` value is zero-filled, so a method
 *     with no rows renders as `{ orderCount: 0, chargeMinor: "0" }`,
 *     not as a missing key — admin UI layout stays stable row-to-row.
 *   - Unknown `payment_method` strings from the driver are silently
 *     dropped (future catalog additions without a handler update
 *     shouldn't break the page). A log-warn captures the drift so
 *     ops sees it.
 *   - `totalOrders` is the sum across methods so the UI can compute
 *     shares without re-summing.
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
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-payment-method-share' });

export interface PaymentMethodBucket {
  orderCount: number;
  /** Sum of charge_minor for orders in this (state, method) bucket. bigint-as-string. */
  chargeMinor: string;
}

export interface PaymentMethodShareResponse {
  state: OrderState;
  totalOrders: number;
  byMethod: Record<OrderPaymentMethod, PaymentMethodBucket>;
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

function zeroFill(): Record<OrderPaymentMethod, PaymentMethodBucket> {
  const out = {} as Record<OrderPaymentMethod, PaymentMethodBucket>;
  for (const m of ORDER_PAYMENT_METHODS) {
    out[m] = { orderCount: 0, chargeMinor: '0' };
  }
  return out;
}

export async function adminPaymentMethodShareHandler(c: Context): Promise<Response> {
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
      WHERE ${orders.state} = ${state}
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
          { paymentMethod: r.payment_method },
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

    return c.json<PaymentMethodShareResponse>({
      state,
      totalOrders,
      byMethod,
    });
  } catch (err) {
    log.error({ err }, 'Admin payment-method-share query failed');
    return c.json(
      { code: 'INTERNAL_ERROR', message: 'Failed to compute payment-method share' },
      500,
    );
  }
}
