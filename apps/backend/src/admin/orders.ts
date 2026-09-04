/**
 * Admin orders drill-down (ADR 011 / 015).
 *
 * `GET /api/admin/orders` — paginated list of Loop orders across
 * every user, with the ADR-052 economics (cashback discount +
 * expected commission) and the CTX identifiers. Ops uses this to:
 *   - audit the CTX-side record (ctxOrderId / ctxPaymentId)
 *   - spot mirrors that stopped moving (state vs createdAt)
 *
 * The user-facing `/api/orders/loop/*` endpoints are scoped to the
 * caller; this one deliberately isn't — admins need to see across
 * accounts. Still authenticated + admin-gated by the middleware
 * mounted in app.ts.
 */
import type { Context } from 'hono';
import { and, eq, lt, sql } from 'drizzle-orm';
import { ORDER_STATES, type OrderState } from '@loop/shared';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-orders' });

// A2-816: ORDER_STATES + OrderState come from `@loop/shared` —
// the CHECK constraint on `orders.state`, the openapi schema, and
// every admin handler now agree on one canonical list. Removing
// the inline re-declaration here closes the drift surface where a
// state added in shared (e.g. a future `refunded`) would silently
// not be accepted by this admin filter.

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
  /** What the customer pays CTX (face minus cashback discount). */
  chargeCurrency: string;
  chargeMinor: string;
  /** Cashback CTX applied as a checkout discount (ADR 052). */
  userCashbackMinor: string;
  /** Commission Loop expects CTX to accrue; null until read-back lands. */
  expectedCommissionMinor: string | null;
  ctxOrderId: string | null;
  ctxPaymentId: string | null;
  /** Chain-qualified CTX payment currency the customer chose. */
  paymentCryptoCurrency: string | null;
  failureReason: string | null;
  createdAt: string;
  fulfilledAt: string | null;
  failedAt: string | null;
}

export interface AdminOrdersListResponse {
  orders: AdminOrderView[];
}

export function rowToView(row: typeof orders.$inferSelect): AdminOrderView {
  return {
    id: row.id,
    userId: row.userId,
    merchantId: row.merchantId,
    state: row.state as OrderState,
    currency: row.currency,
    faceValueMinor: row.faceValueMinor.toString(),
    chargeCurrency: row.chargeCurrency,
    chargeMinor: row.chargeMinor.toString(),
    userCashbackMinor: row.userCashbackMinor.toString(),
    expectedCommissionMinor: row.expectedCommissionMinor?.toString() ?? null,
    ctxOrderId: row.ctxOrderId,
    ctxPaymentId: row.ctxPaymentId,
    paymentCryptoCurrency: row.paymentCryptoCurrency,
    failureReason: row.failureReason,
    createdAt: row.createdAt.toISOString(),
    fulfilledAt: row.fulfilledAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
  };
}

// `adminGetOrderHandler` (single-row drill) lives in
// `./orders-detail.ts`. Re-exported below so the existing import
// path against `'../admin/orders.js'` keeps resolving for
// `routes/admin.ts` and the test suite.
export { adminGetOrderHandler } from './orders-detail.js';

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

  // `orders.merchantId` is a catalog slug, not a uuid (upstream CTX
  // owns the id space). Allow common catalog-id chars but cap at 128
  // to guard against pathological inputs.
  const merchantIdRaw = c.req.query('merchantId');
  if (
    merchantIdRaw !== undefined &&
    (merchantIdRaw.length === 0 ||
      merchantIdRaw.length > 128 ||
      !/^[A-Za-z0-9._-]+$/.test(merchantIdRaw))
  ) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId is malformed' }, 400);
  }

  // `orders.charge_currency` is CHAR(3); accept a plain uppercase
  // ISO code so the pg round-trip never sees an impossible value.
  const chargeCurrencyRaw = c.req.query('chargeCurrency');
  if (chargeCurrencyRaw !== undefined && !/^[A-Z]{3}$/.test(chargeCurrencyRaw)) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'chargeCurrency must be a 3-letter ISO code' },
      400,
    );
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
    if (merchantIdRaw !== undefined) conditions.push(eq(orders.merchantId, merchantIdRaw));
    if (chargeCurrencyRaw !== undefined)
      conditions.push(eq(orders.chargeCurrency, chargeCurrencyRaw));
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
