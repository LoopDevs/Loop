/**
 * Admin supplier-margin summary (ADR 011 / 013 / 015 / 024).
 *
 * `GET /api/admin/supplier-margin` — per-currency lifetime roll-up
 * of Loop's cashback-business economics. The fleet-wide aggregate
 * answers "how much margin has Loop booked across every CTX-
 * supplied order since the cashback pivot?".
 *
 * Fields per row (all bigint-as-string minor units):
 *   - chargeMinor        = SUM(charge_minor) over fulfilled orders
 *   - wholesaleMinor     = SUM(wholesale_minor) — Loop's cost to CTX
 *   - userCashbackMinor  = SUM(user_cashback_minor) — user reward
 *   - loopMarginMinor    = SUM(loop_margin_minor) — Loop's retained margin
 *   - orderCount         = number of fulfilled orders in the bucket
 *   - marginBps          = loop_margin / charge × 10_000 (integer bps)
 *
 * Pairs with the realization (#727) and settlement-lag (#720) cards
 * as the third commercial-health signal — not the same shape as the
 * flywheel ratio (realization is a flow metric; margin is a stock
 * metric), so it gets its own endpoint rather than sharing.
 *
 * Scope: `orders.state = 'fulfilled'` only. Pending / failed /
 * refunded orders haven't realized their margin yet.
 *
 * ADR-024 shape: per-currency rows + fleet-wide row (`currency:
 * null`) via `GROUPING SETS ((currency), ())`. Follow-up slices
 * will add the `/daily` time-series + CSV + UI card.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-supplier-margin' });

export interface SupplierMarginRow {
  currency: string | null;
  chargeMinor: string;
  wholesaleMinor: string;
  userCashbackMinor: string;
  loopMarginMinor: string;
  orderCount: number;
  /** loopMargin / charge × 10 000. Integer bps clamped [0, 10 000]. */
  marginBps: number;
}

export interface SupplierMarginResponse {
  rows: SupplierMarginRow[];
}

interface AggRow extends Record<string, unknown> {
  currency: string | null;
  charge: string | null;
  wholesale: string | null;
  user_cashback: string | null;
  loop_margin: string | null;
  order_count: string | number | bigint | null;
}

function toBigIntSafe(v: string | null): bigint {
  if (v === null) return 0n;
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
}

/**
 * loopMargin / charge × 10 000 in integer basis points. Same
 * div-by-zero / clamp discipline as `recycledBps` (ADR 024 — shared
 * ratio-math invariant): zero charge → 0, negative-margin clamps to
 * 0, overflow clamps to 10 000. Kept local for now; lifts to
 * @loop/shared when a second consumer adopts it.
 */
export function marginBps(chargeMinor: bigint, loopMarginMinor: bigint): number {
  if (chargeMinor <= 0n) return 0;
  const clampedMargin = loopMarginMinor < 0n ? 0n : loopMarginMinor;
  const scaled = (clampedMargin * 10_000n) / chargeMinor;
  const n = Number(scaled);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > 10_000 ? 10_000 : n;
}

export async function adminSupplierMarginHandler(c: Context): Promise<Response> {
  try {
    const result = await db.execute<AggRow>(sql`
      SELECT
        ${orders.chargeCurrency} AS currency,
        COALESCE(SUM(${orders.chargeMinor}), 0)::text AS charge,
        COALESCE(SUM(${orders.wholesaleMinor}), 0)::text AS wholesale,
        COALESCE(SUM(${orders.userCashbackMinor}), 0)::text AS user_cashback,
        COALESCE(SUM(${orders.loopMarginMinor}), 0)::text AS loop_margin,
        COUNT(*)::bigint AS order_count
      FROM ${orders}
      WHERE ${orders.state} = 'fulfilled'
      GROUP BY GROUPING SETS ((${orders.chargeCurrency}), ())
      ORDER BY currency NULLS FIRST
    `);

    const raw = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const rows: SupplierMarginRow[] = [];
    for (const r of raw) {
      const charge = toBigIntSafe(r.charge);
      // Skip per-currency rows with zero charge (no fulfilled orders
      // in that currency) — matches the realization endpoint's
      // "omit empty currencies, always keep the aggregate" rule.
      if (charge === 0n && r.currency !== null) continue;
      const wholesale = toBigIntSafe(r.wholesale);
      const userCashback = toBigIntSafe(r.user_cashback);
      const loopMargin = toBigIntSafe(r.loop_margin);
      const orderCount =
        typeof r.order_count === 'bigint' ? Number(r.order_count) : Number(r.order_count ?? 0);
      rows.push({
        currency: r.currency,
        chargeMinor: charge.toString(),
        wholesaleMinor: wholesale.toString(),
        userCashbackMinor: userCashback.toString(),
        loopMarginMinor: loopMargin.toString(),
        orderCount,
        marginBps: marginBps(charge, loopMargin),
      });
    }

    const body: SupplierMarginResponse = { rows };
    return c.json(body);
  } catch (err) {
    log.error({ err }, 'Supplier-margin aggregation failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to compute supplier margin' }, 500);
  }
}
