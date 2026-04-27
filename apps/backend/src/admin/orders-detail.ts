/**
 * Admin single-order drill handler (ADR 011 / 015).
 *
 * Lifted out of `apps/backend/src/admin/orders.ts` so the
 * single-row drill lives in its own focused module separate
 * from the much larger paginated `adminListOrdersHandler` in
 * the parent file:
 *
 *   - `adminGetOrderHandler` —
 *     `GET /api/admin/orders/:orderId`, permalink for one order
 *     row. Admin UI links each row in the list view to this
 *     endpoint so ops can quote one id in a ticket / incident
 *     note. Also the entry point when the operator starts from
 *     a user-reported order id.
 *
 * `AdminOrderView` interface and `rowToView` row mapper are
 * imported back from the parent rather than duplicated — they're
 * the shared shape across both handlers.
 *
 * Re-exported from `orders.ts` so the existing import path
 * (`'../admin/orders.js'`) used by `routes/admin.ts` and the
 * test suite resolves unchanged.
 */
import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { UUID_RE } from '../uuid.js';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';
import { type AdminOrderView, rowToView } from './orders.js';

const log = logger.child({ handler: 'admin-orders' });

/**
 * Single-order drill-down. The admin UI links each row in the
 * list view at `/api/admin/orders` to this permalink so ops can
 * quote one id in a ticket or incident note. Also the entry point
 * when the operator starts from a user-reported order id.
 *
 * 400 on missing / non-uuid id, 404 when the row doesn't exist,
 * 500 on repo throw.
 */
export async function adminGetOrderHandler(c: Context): Promise<Response> {
  const orderId = c.req.param('orderId');
  if (orderId === undefined || orderId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'orderId is required' }, 400);
  }
  if (!UUID_RE.test(orderId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'orderId must be a uuid' }, 400);
  }
  try {
    const [row] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (row === undefined) {
      return c.json({ code: 'NOT_FOUND', message: 'Order not found' }, 404);
    }
    return c.json<AdminOrderView>(rowToView(row));
  } catch (err) {
    log.error({ err, orderId }, 'Admin order detail failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to fetch order' }, 500);
  }
}
