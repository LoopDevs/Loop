/**
 * Public flywheel-stats endpoint (ADR 015 / 020).
 *
 * `GET /api/public/flywheel-stats` — fleet-wide flywheel scalar for
 * unauthenticated marketing surfaces. Complements the existing
 * `/api/public/cashback-stats` (how much has been emitted) by
 * answering the forward-looking pitch question: *how much of that
 * emission is already being recycled back into new orders?*
 *
 * Shape:
 *   {
 *     windowDays: 30,
 *     fulfilledOrders: N,
 *     recycledOrders: n,
 *     pctRecycled: "12.3"    // one-decimal string so zero-handling
 *                            // + locale formatting stay client-side.
 *   }
 *
 * Scoped to a fixed 30-day window: marketing surfaces don't want
 * "since Loop launched" math because early-days share would be
 * depressed by pre-flywheel orders; 30 days is recent enough to
 * reflect the pivot trajectory without being so narrow as to noise.
 *
 * Public-first conventions (ADR 020):
 *   - Never 500. DB errors fall back to a last-known-good snapshot
 *     if one is cached, otherwise a zeroed response.
 *   - `Cache-Control: public, max-age=300` happy path; `max-age=60`
 *     on the fallback path so a fix lands in under a minute rather
 *     than waiting out the 5-minute TTL.
 *   - No PII — just two counts + a percentage string.
 *
 * Separate from the admin `/api/admin/orders/payment-method-share`
 * by design: admin needs per-rail detail + charge-sum bigint math;
 * the public surface just needs the one at-a-glance number.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'public-flywheel-stats' });

const WINDOW_DAYS = 30;

export interface PublicFlywheelStats {
  windowDays: number;
  fulfilledOrders: number;
  recycledOrders: number;
  /** One-decimal percentage, e.g. `"12.3"`. `"0.0"` when denominator is zero. */
  pctRecycled: string;
}

interface AggRow extends Record<string, unknown> {
  fulfilled: string | number;
  recycled: string | number;
}

function toNumber(value: string | number): number {
  return typeof value === 'number' ? value : Number.parseInt(value, 10);
}

/** In-memory last-known-good snapshot. Serves the never-500 path. */
let lastKnownGood: PublicFlywheelStats | null = null;

const FALLBACK_ZERO: PublicFlywheelStats = {
  windowDays: WINDOW_DAYS,
  fulfilledOrders: 0,
  recycledOrders: 0,
  pctRecycled: '0.0',
};

/** Test-only — reset the cached snapshot between cases. */
export function __resetPublicFlywheelStatsCache(): void {
  lastKnownGood = null;
}

export async function publicFlywheelStatsHandler(c: Context): Promise<Response> {
  try {
    const result = await db.execute<AggRow>(sql`
      SELECT
        COUNT(*)::int                                     AS fulfilled,
        COUNT(*) FILTER (
          WHERE ${orders.paymentMethod} = 'loop_asset'
        )::int                                            AS recycled
      FROM ${orders}
      WHERE ${orders.state} = 'fulfilled'
        AND ${orders.fulfilledAt} IS NOT NULL
        AND ${orders.fulfilledAt}
          >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
             - INTERVAL '1 day' * (${WINDOW_DAYS} - 1)
    `);
    const rows: AggRow[] = Array.isArray(result)
      ? (result as AggRow[])
      : ((result as { rows?: AggRow[] }).rows ?? []);
    const row = rows[0];

    const fulfilled = toNumber(row?.fulfilled ?? 0);
    const recycled = toNumber(row?.recycled ?? 0);
    const pctRecycled = fulfilled > 0 ? ((recycled / fulfilled) * 100).toFixed(1) : '0.0';

    const body: PublicFlywheelStats = {
      windowDays: WINDOW_DAYS,
      fulfilledOrders: fulfilled,
      recycledOrders: recycled,
      pctRecycled,
    };
    lastKnownGood = body;
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(body);
  } catch (err) {
    log.error({ err }, 'Public flywheel-stats computation failed — serving fallback');
    const body = lastKnownGood ?? FALLBACK_ZERO;
    c.header('Cache-Control', 'public, max-age=60');
    return c.json<PublicFlywheelStats>(body);
  }
}
