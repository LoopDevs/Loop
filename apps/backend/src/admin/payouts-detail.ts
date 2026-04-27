/**
 * Admin single-payout detail handlers (ADR 015).
 *
 * Lifted out of `apps/backend/src/admin/payouts.ts` so the two
 * single-row drill handlers live in their own focused module
 * separate from the paginated `adminListPayoutsHandler` in the
 * parent file:
 *
 *   - `adminGetPayoutHandler` — `GET /api/admin/payouts/:id`,
 *     permalink for one row (deep-linked from the list).
 *   - `adminPayoutByOrderHandler` —
 *     `GET /api/admin/orders/:orderId/payout`, jumps from an
 *     order id straight to the matching payout row (UNIQUE on
 *     order_id), saves ops fishing through the list.
 *
 * Re-exported from `payouts.ts` so the existing import path
 * (`'../admin/payouts.js'`) used by `routes/admin.ts` and the
 * test suite resolves unchanged. `AdminPayoutView` and the
 * `toView` row mapper get upgraded to exports in the parent so
 * this sibling can import them back rather than duplicate.
 */
import type { Context } from 'hono';
import { UUID_RE } from '../uuid.js';
import { getPayoutByOrderId, getPayoutForAdmin } from '../credits/pending-payouts.js';
import { logger } from '../logger.js';
import { type AdminPayoutView, type PayoutRow, toView } from './payouts.js';

const log = logger.child({ handler: 'admin-payouts' });

/**
 * GET /api/admin/payouts/:id — single-row drill-down. The list
 * endpoint at `/api/admin/payouts` truncates the admin UI at 100 rows
 * and has no per-row permalink; this endpoint is what the admin table
 * links each row to so ops can deep-link a specific stuck payout into
 * a ticket / incident note without hunting for the row in the list.
 *
 * 400 on missing / malformed id (must be a uuid — the column is a uuid
 * pk, so anything else is guaranteed to miss). 404 when the row
 * doesn't exist. 500 on repo throw.
 */
export async function adminGetPayoutHandler(c: Context): Promise<Response> {
  const id = c.req.param('id');
  if (id === undefined || id.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'id is required' }, 400);
  }
  if (!UUID_RE.test(id)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'id must be a uuid' }, 400);
  }
  try {
    const row = await getPayoutForAdmin(id);
    if (row === null) {
      return c.json({ code: 'NOT_FOUND', message: 'Payout not found' }, 404);
    }
    return c.json<AdminPayoutView>(toView(row as PayoutRow));
  } catch (err) {
    log.error({ err, payoutId: id }, 'Admin payout detail failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to fetch payout' }, 500);
  }
}

/**
 * GET /api/admin/orders/:orderId/payout — given an order id, return
 * the single pending_payouts row associated with it (UNIQUE on
 * order_id). Ops hits this when a user raises a support ticket
 * quoting an order id — saves them fishing through the payout list
 * for the matching row.
 *
 * 400 on missing / non-uuid order id, 404 when the order has no
 * payout row yet (common — the payout builder only runs once
 * cashback is due). 500 on repo throw.
 */
export async function adminPayoutByOrderHandler(c: Context): Promise<Response> {
  const orderId = c.req.param('orderId');
  if (orderId === undefined || orderId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'orderId is required' }, 400);
  }
  if (!UUID_RE.test(orderId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'orderId must be a uuid' }, 400);
  }
  try {
    const row = await getPayoutByOrderId(orderId);
    if (row === null) {
      return c.json({ code: 'NOT_FOUND', message: 'No payout for this order' }, 404);
    }
    return c.json<AdminPayoutView>(toView(row as PayoutRow));
  } catch (err) {
    log.error({ err, orderId }, 'Admin payout-by-order lookup failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to fetch payout' }, 500);
  }
}
