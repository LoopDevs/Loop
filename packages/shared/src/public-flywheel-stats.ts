/**
 * Public flywheel-stats wire shape (ADR 015 / 019 / 020).
 *
 * Single source of truth for the `/api/public/flywheel-stats`
 * endpoint response consumed by both
 * `apps/backend/src/public/flywheel-stats.ts` and
 * `apps/web/app/services/public-stats.ts`. Promoted from duplicated
 * local declarations after the ADR 019 two-consumer threshold was met.
 */

/** `GET /api/public/flywheel-stats` response. */
export interface PublicFlywheelStats {
  windowDays: number;
  fulfilledOrders: number;
  recycledOrders: number;
  /** One-decimal percentage string, e.g. `"12.3"`. `"0.0"` when denominator is zero. */
  pctRecycled: string;
}
