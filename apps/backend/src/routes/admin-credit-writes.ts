/**
 * `/api/admin/users/:userId/{credit-adjustments,refunds,withdrawals}`
 * route mounts (ADR 017 / 024 + A2-901).
 *
 * Lifted out of `apps/backend/src/routes/admin.ts`. Three POST
 * routes that share the ADR-017 admin-write contract:
 *
 *   - actor from `requireAuth`
 *   - `Idempotency-Key` header (16-128 char opaque token)
 *   - `reason` body field (2-500 chars)
 *   - append-only `credit_transactions` row
 *   - Discord audit fanout AFTER commit
 *   - uniform `{ result, audit }` response envelope
 *
 * Mirrors the openapi/admin-credit-writes.ts split (#1175). Same
 * three POSTs co-located on both sides of the spec/code boundary.
 *
 * Mount-order semantics shared with `mountAdminRoutes`: this
 * factory MUST be called AFTER the 4-piece middleware stack
 * (cache-control / requireAuth / requireAdmin / audit middleware)
 * is in place; that\'s the parent factory\'s responsibility. The
 * withdrawal route also wears the `withdrawals` killSwitch — the
 * switch state is checked per-request inside the kill-switch
 * middleware, NOT at registration time, so the route still mounts
 * even when the switch is engaged.
 */
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { killSwitch } from '../middleware/kill-switch.js';
import { adminCreditAdjustmentHandler } from '../admin/credit-adjustments.js';
import { adminRefundHandler } from '../admin/refunds.js';
import { adminWithdrawalHandler } from '../admin/withdrawals.js';

/**
 * Mounts the admin credit-write routes on the supplied Hono app.
 * Called once from `mountAdminRoutes` after the admin middleware
 * stack is in place.
 */
export function mountAdminCreditWritesRoutes(app: Hono): void {
  // Credit-adjustment write (ADR 017). Lower rate limit than reads —
  // it's an explicit ops action, not a polled surface. Idempotency-Key
  // header required; missing header is a 400 at the handler edge.
  app.post(
    '/api/admin/users/:userId/credit-adjustments',
    rateLimit(20, 60_000),
    adminCreditAdjustmentHandler,
  );
  // Refund write (A2-901 + ADR 017). Separate surface from credit-
  // adjustment because refund semantics are positive-only and bind to
  // an order id, with DB-level dupe rejection via the partial unique
  // index on (type, reference_type, reference_id) from migration 0013.
  // Same rate limit and idempotency discipline as the adjustment
  // write.
  app.post('/api/admin/users/:userId/refunds', rateLimit(20, 60_000), adminRefundHandler);
  // ADR-024 / A2-901 — admin-mediated withdrawal: debit user's
  // cashback balance + queue an on-chain LOOP-asset payout. Same
  // rate limit + idempotency discipline as refund.
  app.post(
    '/api/admin/users/:userId/withdrawals',
    killSwitch('withdrawals'),
    rateLimit(20, 60_000),
    adminWithdrawalHandler,
  );
}
