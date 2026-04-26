/**
 * A2-1165 (slice 24): admin orders surface extracted from
 * `services/admin.ts`. The Loop-native orders table view that
 * powers `/admin/orders` (ADR 011 / 015):
 *
 * - `AdminOrderState` — re-export of `OrderState` from
 *   `@loop/shared`. The single source of truth for the order
 *   state machine (ADR 010 + the backend CHECK constraint).
 *   The alias is kept so existing consumers (`UserOrdersTable`,
 *   the admin orders routes) don't need to re-import.
 * - `AdminOrderView` — admin-shaped order row. Carries the full
 *   cashback split (`wholesalePct` / `userCashbackPct` /
 *   `loopMarginPct` as `numeric(5,2)` strings + matching minor-
 *   unit columns), CTX procurement metadata, every state
 *   transition timestamp.
 * - `GET /api/admin/orders/:orderId` — single drill-down. 404
 *   when the id doesn't match.
 * - `GET /api/admin/orders` — paginated list with mix-axis
 *   filters (`state` / `userId` / `merchantId` / `chargeCurrency`
 *   / `paymentMethod` / `ctxOperatorId`). Cursor via
 *   `before=<iso>`.
 *
 * `AdminOrderView` was inline in `services/admin.ts` and moves
 * with the functions. It's the single row shape behind every
 * orders surface, so promoting it to `@loop/shared` could be
 * justified — but it has no backend / mobile consumer today, so
 * keeping it here defers that until a real cross-package
 * consumer appears (ADR 019 three-part test). `services/admin.ts`
 * keeps a barrel re-export so existing consumers
 * (`AdminOrdersTable.tsx`, `UserOrdersTable.tsx`,
 * `routes/admin.orders.tsx`, paired tests) don't have to
 * re-target imports.
 */
import type { OrderState } from '@loop/shared';
import type { AdminPaymentMethod } from './admin-payment-method-share';
import { authenticatedRequest } from './api-client';

/**
 * Re-export of `OrderState` from `@loop/shared`. Kept under the
 * `AdminOrderState` name so existing consumers (`UserOrdersTable`,
 * the admin orders routes) don't need to re-import.
 */
export type AdminOrderState = OrderState;

/** Admin-shaped row from `/api/admin/orders` (ADR 011 / 015). */
export interface AdminOrderView {
  id: string;
  userId: string;
  merchantId: string;
  state: AdminOrderState;
  currency: string;
  faceValueMinor: string;
  chargeCurrency: string;
  chargeMinor: string;
  paymentMethod: 'xlm' | 'usdc' | 'credit' | 'loop_asset';
  /** `numeric(5,2)` as string (e.g. `"80.00"`). */
  wholesalePct: string;
  userCashbackPct: string;
  loopMarginPct: string;
  wholesaleMinor: string;
  userCashbackMinor: string;
  loopMarginMinor: string;
  ctxOrderId: string | null;
  ctxOperatorId: string | null;
  failureReason: string | null;
  createdAt: string;
  paidAt: string | null;
  procuredAt: string | null;
  fulfilledAt: string | null;
  failedAt: string | null;
}

/**
 * `GET /api/admin/orders/:orderId` — single Loop-native order
 * drill-down. Returns the same shape as a single row from the list
 * endpoint; 404 when the id doesn't match.
 */
export async function getAdminOrder(orderId: string): Promise<AdminOrderView> {
  return authenticatedRequest<AdminOrderView>(`/api/admin/orders/${encodeURIComponent(orderId)}`);
}

/** `GET /api/admin/orders` — paginated, filterable admin view. */
export async function listAdminOrders(opts: {
  state?: AdminOrderState;
  userId?: string;
  merchantId?: string;
  chargeCurrency?: string;
  paymentMethod?: AdminPaymentMethod;
  ctxOperatorId?: string;
  limit?: number;
  before?: string;
}): Promise<{ orders: AdminOrderView[] }> {
  const params = new URLSearchParams();
  if (opts.state !== undefined) params.set('state', opts.state);
  if (opts.userId !== undefined) params.set('userId', opts.userId);
  if (opts.merchantId !== undefined) params.set('merchantId', opts.merchantId);
  if (opts.chargeCurrency !== undefined) params.set('chargeCurrency', opts.chargeCurrency);
  if (opts.paymentMethod !== undefined) params.set('paymentMethod', opts.paymentMethod);
  if (opts.ctxOperatorId !== undefined) params.set('ctxOperatorId', opts.ctxOperatorId);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.before !== undefined) params.set('before', opts.before);
  const qs = params.toString();
  return authenticatedRequest<{ orders: AdminOrderView[] }>(
    `/api/admin/orders${qs.length > 0 ? `?${qs}` : ''}`,
  );
}
