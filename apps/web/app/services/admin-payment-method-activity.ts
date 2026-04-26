/**
 * A2-1165 (slice 21): admin payment-method-activity surface
 * extracted from `services/admin.ts`. One read backs the daily
 * payment-method time-series chart on the admin dashboard
 * (ADR 015 / 023):
 *
 * - `GET /api/admin/orders/payment-method-activity` — one row
 *   per UTC day in the requested window (default 30, cap 90),
 *   with fulfilled-order counts per rail. Every rail is always
 *   present — the backend pre-seeds zero buckets — so the
 *   chart component doesn't gap-fill. Trend complement to the
 *   scalar `getPaymentMethodShare` from slice 13: share answers
 *   "where are we now", this one answers "where are we going".
 *
 * The `PaymentMethodActivityDay` /
 * `AdminPaymentMethodActivityResponse` shapes were inline in
 * `services/admin.ts` and move with the function. They have no
 * other consumers, so promoting them to `@loop/shared` would
 * just add indirection. `services/admin.ts` keeps a barrel
 * re-export so existing consumers
 * (`PaymentMethodActivityChart.tsx`, paired test) don't have
 * to re-target imports. `AdminPaymentMethod` is imported from
 * the existing slice 13 extraction.
 */
import type { AdminPaymentMethod } from './admin-payment-method-share';
import { authenticatedRequest } from './api-client';

/**
 * One row per UTC day in the requested window. Every rail is
 * always present — the backend pre-seeds zero buckets — so the
 * chart component doesn't gap-fill.
 */
export interface PaymentMethodActivityDay {
  /** YYYY-MM-DD (UTC). */
  day: string;
  byMethod: Record<AdminPaymentMethod, number>;
}

export interface AdminPaymentMethodActivityResponse {
  /** Oldest-first so the chart renders left-to-right. */
  days: PaymentMethodActivityDay[];
  windowDays: number;
}

/** `GET /api/admin/orders/payment-method-activity` — server clamps `?days=` to [1, 90], default 30. */
export async function getAdminPaymentMethodActivity(
  opts: { days?: number } = {},
): Promise<AdminPaymentMethodActivityResponse> {
  const params = new URLSearchParams();
  if (opts.days !== undefined) params.set('days', String(opts.days));
  const qs = params.toString();
  return authenticatedRequest<AdminPaymentMethodActivityResponse>(
    `/api/admin/orders/payment-method-activity${qs.length > 0 ? `?${qs}` : ''}`,
  );
}
