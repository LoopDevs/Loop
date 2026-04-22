/**
 * Admin payment-method share (ADR 010 / 015).
 *
 * `GET /api/admin/orders/payment-method-share?state=fulfilled` —
 * single GROUP BY over `orders.payment_method` telling ops how users
 * are paying. The cashback flywheel relies on users paying with
 * `loop_asset` (the stablecoin credit balance) rather than XLM, so
 * the share shift from xlm → loop_asset is a first-class metric.
 *
 * Optional `?state=<enum>` filter — defaults to `fulfilled` because
 * pending_payment rows skew the signal while users are still on the
 * checkout page. Admins flipping this to `paid` see the in-flight mix
 * without waiting for procurement to clear.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { ORDER_PAYMENT_METHODS, ORDER_STATES, orders } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-payment-method-share' });

type PaymentMethod = (typeof ORDER_PAYMENT_METHODS)[number];

export interface PaymentMethodEntry {
  orderCount: number;
  /** Sum of `charge_minor` for these orders, bigint-safe string. */
  chargeMinor: string;
}

export interface AdminPaymentMethodShareResponse {
  /** Echoed state filter (e.g. 'fulfilled'). */
  state: string;
  /** Across-all-methods count. Equals sum(byMethod.*.orderCount). */
  totalOrders: number;
  /** Zero-filled over every known payment method for stable UI layout. */
  byMethod: Record<PaymentMethod, PaymentMethodEntry>;
}

interface Row extends Record<string, unknown> {
  paymentMethod: string;
  n: string | number;
  chargeSum: string | null;
}

const DEFAULT_STATE = 'fulfilled';

export async function adminPaymentMethodShareHandler(c: Context): Promise<Response> {
  const stateRaw = c.req.query('state') ?? DEFAULT_STATE;
  if (!(ORDER_STATES as ReadonlyArray<string>).includes(stateRaw)) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: `state must be one of: ${ORDER_STATES.join(', ')}`,
      },
      400,
    );
  }

  try {
    const result = await db.execute<Row>(sql`
      SELECT
        ${orders.paymentMethod} AS "paymentMethod",
        COUNT(*)::bigint AS n,
        COALESCE(SUM(${orders.chargeMinor}), 0)::bigint AS "chargeSum"
      FROM ${orders}
      WHERE ${orders.state} = ${stateRaw}
      GROUP BY ${orders.paymentMethod}
    `);
    const rows: Row[] = Array.isArray(result)
      ? (result as Row[])
      : ((result as { rows?: Row[] }).rows ?? []);

    // Zero-fill every known method so the UI renders a stable layout
    // even when no user has touched one of the methods yet.
    const byMethod = Object.fromEntries(
      ORDER_PAYMENT_METHODS.map((m) => [m, { orderCount: 0, chargeMinor: '0' }]),
    ) as Record<PaymentMethod, PaymentMethodEntry>;

    let totalOrders = 0;
    for (const row of rows) {
      const method = row.paymentMethod as PaymentMethod;
      if (!(ORDER_PAYMENT_METHODS as ReadonlyArray<string>).includes(method)) continue;
      const n = Number(row.n);
      byMethod[method] = {
        orderCount: n,
        chargeMinor: (row.chargeSum ?? '0').toString(),
      };
      totalOrders += n;
    }

    return c.json<AdminPaymentMethodShareResponse>({
      state: stateRaw,
      totalOrders,
      byMethod,
    });
  } catch (err) {
    log.error({ err }, 'Admin payment-method share failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load payment-method share' }, 500);
  }
}
