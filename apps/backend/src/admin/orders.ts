/**
 * Admin orders drill-down (ADR 011 / 015).
 *
 * `GET /api/admin/orders` — paginated list of Loop-native orders
 * across every user, with the full ADR-015 cashback-split breakdown
 * + CTX procurement record. Ops uses this to:
 *   - triage stuck orders (state=paid without a ctxOrderId)
 *   - audit how cashback is being split (wholesale / user / margin)
 *   - correlate procurement with operator-pool health (ctxOperatorId)
 *
 * The user-facing `/api/orders/loop/*` endpoints are scoped to the
 * caller; this one deliberately isn't — admins need to see across
 * accounts. Still authenticated + admin-gated by the middleware
 * mounted in app.ts.
 */
import type { Context } from 'hono';
import { and, eq, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-orders' });

/** State enum — mirrors the CHECK constraint on `orders.state`. */
const ORDER_STATES = [
  'pending_payment',
  'paid',
  'procuring',
  'fulfilled',
  'failed',
  'expired',
] as const;
type OrderState = (typeof ORDER_STATES)[number];

/**
 * Compact admin view of an order row. BigInt columns round-trip as
 * strings; ISO-8601 for all timestamps. Skips the redeem_code /
 * redeem_pin fields on purpose — that's the gift card itself, and
 * the admin view doesn't need them to diagnose order state.
 */
export interface AdminOrderView {
  id: string;
  userId: string;
  merchantId: string;
  state: OrderState;
  /** ISO currency of the face value (merchant region). */
  currency: string;
  /** Face-value minor units (pence / cents), bigint-string. */
  faceValueMinor: string;
  /** ISO currency the user was charged in (home region). */
  chargeCurrency: string;
  chargeMinor: string;
  paymentMethod: 'xlm' | 'usdc' | 'credit' | 'loop_asset';
  /** Pinned cashback split (ADR 011): numeric(5,2) as string. */
  wholesalePct: string;
  userCashbackPct: string;
  loopMarginPct: string;
  /** Minor-unit shares computed at creation time (ADR 015). */
  wholesaleMinor: string;
  userCashbackMinor: string;
  loopMarginMinor: string;
  /** CTX-side procurement record. Null until state ≥ procuring. */
  ctxOrderId: string | null;
  ctxOperatorId: string | null;
  failureReason: string | null;
  createdAt: string;
  paidAt: string | null;
  procuredAt: string | null;
  fulfilledAt: string | null;
  failedAt: string | null;
}

export interface AdminOrdersListResponse {
  orders: AdminOrderView[];
}

function rowToView(row: typeof orders.$inferSelect): AdminOrderView {
  return {
    id: row.id,
    userId: row.userId,
    merchantId: row.merchantId,
    state: row.state as OrderState,
    currency: row.currency,
    faceValueMinor: row.faceValueMinor.toString(),
    chargeCurrency: row.chargeCurrency,
    chargeMinor: row.chargeMinor.toString(),
    paymentMethod: row.paymentMethod as AdminOrderView['paymentMethod'],
    wholesalePct: row.wholesalePct,
    userCashbackPct: row.userCashbackPct,
    loopMarginPct: row.loopMarginPct,
    wholesaleMinor: row.wholesaleMinor.toString(),
    userCashbackMinor: row.userCashbackMinor.toString(),
    loopMarginMinor: row.loopMarginMinor.toString(),
    ctxOrderId: row.ctxOrderId,
    ctxOperatorId: row.ctxOperatorId,
    failureReason: row.failureReason,
    createdAt: row.createdAt.toISOString(),
    paidAt: row.paidAt?.toISOString() ?? null,
    procuredAt: row.procuredAt?.toISOString() ?? null,
    fulfilledAt: row.fulfilledAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
  };
}

export interface AdminOrdersSummaryResponse {
  /** Orders-in-flight counts per state (all currencies combined). */
  counts: Record<OrderState, number>;
  /** Lifetime fulfilled volume per chargeCurrency. */
  fulfilledTotals: Record<
    string,
    {
      orderCount: number;
      faceMinor: string;
      chargeMinor: string;
      userCashbackMinor: string;
      loopMarginMinor: string;
    }
  >;
  /** Paid + procuring (capital committed but not yet fulfilled) per chargeCurrency. */
  outstandingTotals: Record<string, { orderCount: number; chargeMinor: string }>;
}

interface SummaryRow extends Record<string, unknown> {
  state: string;
  chargeCurrency: string;
  n: string | number;
  faceSum: string | null;
  chargeSum: string | null;
  cashbackSum: string | null;
  marginSum: string | null;
}

/**
 * GET /api/admin/orders/summary
 *
 * Single GROUP BY over (state, chargeCurrency) — one round-trip gives
 * us state counts, per-currency fulfilled volume, and per-currency
 * outstanding commitments. Intended to render the chip strip at the
 * top of /admin/orders without requiring a CSV dump.
 */
export async function adminOrdersSummaryHandler(c: Context): Promise<Response> {
  try {
    const result = await db.execute<SummaryRow>(sql`
      SELECT
        ${orders.state} AS state,
        ${orders.chargeCurrency} AS "chargeCurrency",
        COUNT(*)::bigint AS n,
        COALESCE(SUM(${orders.faceValueMinor}), 0)::bigint AS "faceSum",
        COALESCE(SUM(${orders.chargeMinor}), 0)::bigint AS "chargeSum",
        COALESCE(SUM(${orders.userCashbackMinor}), 0)::bigint AS "cashbackSum",
        COALESCE(SUM(${orders.loopMarginMinor}), 0)::bigint AS "marginSum"
      FROM ${orders}
      GROUP BY ${orders.state}, ${orders.chargeCurrency}
    `);

    const rows: SummaryRow[] = Array.isArray(result)
      ? (result as SummaryRow[])
      : ((result as { rows?: SummaryRow[] }).rows ?? []);

    const counts: Record<OrderState, number> = {
      pending_payment: 0,
      paid: 0,
      procuring: 0,
      fulfilled: 0,
      failed: 0,
      expired: 0,
    };
    const fulfilledTotals: AdminOrdersSummaryResponse['fulfilledTotals'] = {};
    const outstandingTotals: AdminOrdersSummaryResponse['outstandingTotals'] = {};

    for (const row of rows) {
      const n = Number(row.n);
      const state = row.state as OrderState;
      if ((ORDER_STATES as ReadonlyArray<string>).includes(state)) {
        counts[state] += n;
      }
      if (state === 'fulfilled') {
        fulfilledTotals[row.chargeCurrency] = {
          orderCount: n,
          faceMinor: (row.faceSum ?? '0').toString(),
          chargeMinor: (row.chargeSum ?? '0').toString(),
          userCashbackMinor: (row.cashbackSum ?? '0').toString(),
          loopMarginMinor: (row.marginSum ?? '0').toString(),
        };
      }
      if (state === 'paid' || state === 'procuring') {
        const existing = outstandingTotals[row.chargeCurrency];
        const addChargeMinor = BigInt(row.chargeSum ?? '0');
        if (existing === undefined) {
          outstandingTotals[row.chargeCurrency] = {
            orderCount: n,
            chargeMinor: addChargeMinor.toString(),
          };
        } else {
          outstandingTotals[row.chargeCurrency] = {
            orderCount: existing.orderCount + n,
            chargeMinor: (BigInt(existing.chargeMinor) + addChargeMinor).toString(),
          };
        }
      }
    }

    return c.json<AdminOrdersSummaryResponse>({ counts, fulfilledTotals, outstandingTotals });
  } catch (err) {
    log.error({ err }, 'Admin orders summary failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load orders summary' }, 500);
  }
}

export async function adminListOrdersHandler(c: Context): Promise<Response> {
  const stateRaw = c.req.query('state');
  if (stateRaw !== undefined && !(ORDER_STATES as ReadonlyArray<string>).includes(stateRaw)) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: `state must be one of: ${ORDER_STATES.join(', ')}`,
      },
      400,
    );
  }

  const userIdRaw = c.req.query('userId');
  // UUID format — same shape as `users.id`. Reject anything else to
  // avoid pg casting surprises.
  if (
    userIdRaw !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userIdRaw)
  ) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a UUID' }, 400);
  }

  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? '20', 10);
  const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? 20 : parsedLimit, 1), 100);

  const beforeRaw = c.req.query('before');
  let before: Date | undefined;
  if (beforeRaw !== undefined && beforeRaw.length > 0) {
    const d = new Date(beforeRaw);
    if (Number.isNaN(d.getTime())) {
      return c.json(
        { code: 'VALIDATION_ERROR', message: 'before must be an ISO-8601 timestamp' },
        400,
      );
    }
    before = d;
  }

  try {
    const conditions = [];
    if (stateRaw !== undefined) conditions.push(eq(orders.state, stateRaw));
    if (userIdRaw !== undefined) conditions.push(eq(orders.userId, userIdRaw));
    if (before !== undefined) conditions.push(lt(orders.createdAt, before));
    const where = conditions.length === 0 ? undefined : and(...conditions);
    const q = db.select().from(orders);
    const filtered = where === undefined ? q : q.where(where);
    const rows = await filtered.orderBy(sql`${orders.createdAt} DESC`).limit(limit);
    return c.json<AdminOrdersListResponse>({ orders: rows.map(rowToView) });
  } catch (err) {
    log.error({ err }, 'Admin orders list failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to list orders' }, 500);
  }
}
