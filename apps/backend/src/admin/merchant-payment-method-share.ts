/**
 * Admin per-merchant payment-method share (#627).
 *
 * `GET /api/admin/merchants/:merchantId/payment-method-share?state=fulfilled` —
 * the merchant-scoped mirror of the fleet-wide
 * `/api/admin/orders/payment-method-share`. Groups the target
 * merchant's orders by payment rail and returns a zero-filled
 * `byMethod` record so the admin UI layout stays stable per
 * merchant.
 *
 * Why this exists separately from the fleet-wide version: ops needs
 * to answer "at Amazon, what fraction of orders were paid with
 * LOOP asset cashback?" — the leaderboard on `/admin/cashback` only
 * shows the count ratio, not the charge-weighted mix. This endpoint
 * drives a small "rail mix" card on the merchant drill-down
 * alongside the flywheel chip + cashback-paid card.
 *
 * Invariants:
 *   - Default `?state=fulfilled` so in-flight pending_payment rows
 *     don't skew the mix (same default the fleet endpoint picks).
 *   - Every `ORDER_PAYMENT_METHODS` value is zero-filled.
 *   - Unknown `payment_method` values dropped with a log-warn.
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

const log = logger.child({ handler: 'admin-merchant-payment-method-share' });

const MERCHANT_ID_RE = /^[A-Za-z0-9._-]+$/;
const MERCHANT_ID_MAX = 128;

export interface MerchantPaymentMethodBucket {
  orderCount: number;
  /** SUM(charge_minor) for this (merchant, state, method) bucket. bigint-as-string. */
  chargeMinor: string;
}

export interface MerchantPaymentMethodShareResponse {
  merchantId: string;
  state: OrderState;
  totalOrders: number;
  byMethod: Record<OrderPaymentMethod, MerchantPaymentMethodBucket>;
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

function zeroFill(): Record<OrderPaymentMethod, MerchantPaymentMethodBucket> {
  const out = {} as Record<OrderPaymentMethod, MerchantPaymentMethodBucket>;
  for (const m of ORDER_PAYMENT_METHODS) {
    out[m] = { orderCount: 0, chargeMinor: '0' };
  }
  return out;
}

export async function adminMerchantPaymentMethodShareHandler(c: Context): Promise<Response> {
  const merchantId = c.req.param('merchantId');
  if (merchantId === undefined || merchantId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId is required' }, 400);
  }
  if (merchantId.length > MERCHANT_ID_MAX || !MERCHANT_ID_RE.test(merchantId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId is malformed' }, 400);
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
      WHERE ${and(eq(orders.merchantId, merchantId), eq(orders.state, state))}
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
          { paymentMethod: r.payment_method, merchantId },
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

    return c.json<MerchantPaymentMethodShareResponse>({
      merchantId,
      state,
      totalOrders,
      byMethod,
    });
  } catch (err) {
    log.error({ err, merchantId }, 'Admin merchant payment-method-share query failed');
    return c.json(
      { code: 'INTERNAL_ERROR', message: 'Failed to compute merchant payment-method share' },
      500,
    );
  }
}
