/**
 * Admin daily payment-method activity (ADR 010 / 015).
 *
 * `GET /api/admin/orders/payment-method-activity?days=N` — time-
 * series of daily fulfilled-order counts, pivoted per payment method
 * (xlm / usdc / credit / loop_asset). Turns the scalar
 * `/orders/payment-method-share` snapshot into a trend — the chart
 * that answers "is the `loop_asset` share *rising* day-over-day, or
 * are we just seeing one-off flywheel orders?".
 *
 * The signal ADR 015 is optimising for: `loop_asset` share trending
 * up, because that means cashback credited yesterday was spent back
 * into new orders today. Snapshot and trend are complementary —
 * operators use share for "where are we now" and activity for
 * "where are we going".
 *
 * Bucketed on `fulfilled_at` (not `created_at`) so the time axis
 * matches the share card's `?state=fulfilled` framing. Orders created
 * but not yet fulfilled don't show up here — the share card says so
 * too by filtering on state, and mixing creation / fulfillment
 * timelines is confusing.
 *
 * Zero-filled via `generate_series` so every day appears even when
 * no fulfillment crossed on it — stable chart layout without client-
 * side gap filling. Per-method keys always present (backend
 * guarantees the shape is `Record<ORDER_PAYMENT_METHODS, number>`).
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { ORDER_PAYMENT_METHODS, type OrderPaymentMethod } from '@loop/shared';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-payment-method-activity' });

export interface PaymentMethodActivityDay {
  /** YYYY-MM-DD in UTC. */
  day: string;
  /**
   * Fulfilled-order count keyed on every `ORDER_PAYMENT_METHODS`
   * value. Always present; zero when no orders on that rail.
   */
  byMethod: Record<OrderPaymentMethod, number>;
}

export interface AdminPaymentMethodActivityResponse {
  /** Oldest-first so a chart renders left-to-right. */
  days: PaymentMethodActivityDay[];
  windowDays: number;
}

interface Row extends Record<string, unknown> {
  day: string | Date;
  payment_method: string;
  c: string | number;
}

function emptyDayBucket(): Record<OrderPaymentMethod, number> {
  const out = {} as Record<OrderPaymentMethod, number>;
  for (const m of ORDER_PAYMENT_METHODS) out[m] = 0;
  return out;
}

export async function adminPaymentMethodActivityHandler(c: Context): Promise<Response> {
  const daysRaw = c.req.query('days');
  const parsedDays = Number.parseInt(daysRaw ?? '30', 10);
  // Default 30 (monthly view); floor 1, cap 90 (quarter of daily
  // buckets renders sensibly; beyond that use /cashback-monthly).
  const windowDays = Math.min(Math.max(Number.isNaN(parsedDays) ? 30 : parsedDays, 1), 90);

  try {
    const result = await db.execute<Row>(sql`
      SELECT
        TO_CHAR(
          DATE_TRUNC('day', ${orders.fulfilledAt} AT TIME ZONE 'UTC'),
          'YYYY-MM-DD'
        )                                                   AS day,
        ${orders.paymentMethod}                              AS payment_method,
        COUNT(*)::bigint                                     AS c
      FROM ${orders}
      WHERE ${orders.state} = 'fulfilled'
        AND ${orders.fulfilledAt} IS NOT NULL
        AND ${orders.fulfilledAt}
          >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
             - INTERVAL '1 day' * (${windowDays} - 1)
      GROUP BY day, payment_method
      ORDER BY day ASC
    `);
    const rows: Row[] = Array.isArray(result)
      ? (result as Row[])
      : ((result as { rows?: Row[] }).rows ?? []);

    // Pre-seed every day in the window with zeros so the UI
    // doesn't gap-fill client-side. generate_series on the server
    // would merge tidily but costs a join; in-memory seeding is
    // simpler and the window is bounded at 90 days.
    const daysMap = new Map<string, Record<OrderPaymentMethod, number>>();
    const today = new Date();
    // Seed YYYY-MM-DD strings for (today - (windowDays-1)) ... today
    // using UTC days so the server boundary matches the query.
    const baseUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    for (let i = windowDays - 1; i >= 0; i--) {
      const d = new Date(baseUtc - i * 86_400_000);
      const key = d.toISOString().slice(0, 10);
      daysMap.set(key, emptyDayBucket());
    }

    for (const r of rows) {
      const key = typeof r.day === 'string' ? r.day : r.day.toISOString().slice(0, 10);
      const bucket = daysMap.get(key);
      if (bucket === undefined) continue; // out-of-window row — ignore
      if (!(ORDER_PAYMENT_METHODS as readonly string[]).includes(r.payment_method)) {
        log.warn(
          { paymentMethod: r.payment_method, day: key },
          'Unknown payment_method in activity aggregate — dropping from response',
        );
        continue;
      }
      bucket[r.payment_method as OrderPaymentMethod] = Number(r.c);
    }

    const daysOut: PaymentMethodActivityDay[] = Array.from(daysMap.entries()).map(
      ([day, byMethod]) => ({ day, byMethod }),
    );

    return c.json<AdminPaymentMethodActivityResponse>({
      days: daysOut,
      windowDays,
    });
  } catch (err) {
    log.error({ err }, 'Admin payment-method-activity query failed');
    return c.json(
      { code: 'INTERNAL_ERROR', message: 'Failed to load payment-method activity' },
      500,
    );
  }
}
