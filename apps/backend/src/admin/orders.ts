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
import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';
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

export interface AdminStuckOrdersResponse {
  /**
   * The threshold (in minutes) this response was computed against —
   * echoed so clients can reuse the response in UI without re-parsing
   * the query string.
   */
  thresholdMinutes: number;
  /** Oldest-paidAt-first. Empty when nothing is stuck. */
  orders: AdminOrderView[];
}

/**
 * GET /api/admin/orders/stuck?minutes=30
 *
 * Triage tool: orders that have been sitting in `paid` state without a
 * CTX procurement record for longer than the threshold. The normal
 * state is <1 minute — operator-pool exhaustion, CTX outage, or the
 * procurement worker wedging are the scenarios that put rows here.
 *
 * Oldest-first ordering matches ops intuition ("what's been stuck the
 * longest?"). `paidAt` is the anchor because `createdAt` would include
 * pending_payment rows still waiting on the user.
 */
export async function adminStuckOrdersHandler(c: Context): Promise<Response> {
  const minutesRaw = c.req.query('minutes');
  const parsedMinutes = Number.parseInt(minutesRaw ?? '30', 10);
  // Floor at 1 (anything below is noise), cap at 1440 (24h — beyond
  // that it's no longer "stuck", it's abandoned).
  const minutes = Math.min(Math.max(Number.isNaN(parsedMinutes) ? 30 : parsedMinutes, 1), 1440);

  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? '50', 10);
  const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? 50 : parsedLimit, 1), 200);

  try {
    const cutoff = new Date(Date.now() - minutes * 60_000);
    const rows = await db
      .select()
      .from(orders)
      .where(and(eq(orders.state, 'paid'), isNull(orders.ctxOrderId), lt(orders.paidAt, cutoff)))
      .orderBy(asc(orders.paidAt))
      .limit(limit);
    return c.json<AdminStuckOrdersResponse>({
      thresholdMinutes: minutes,
      orders: rows.map(rowToView),
    });
  } catch (err) {
    log.error({ err }, 'Admin stuck-orders query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load stuck orders' }, 500);
  }
}
