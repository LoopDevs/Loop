/**
 * A2-1165 (slice 5): admin cashback-realization surface extracted
 * from `services/admin.ts`. Two reads cover the flywheel-health
 * KPI (ADR 009 / 015 — `recycledBps = spent / earned × 10 000`):
 *
 * - `GET /api/admin/cashback-realization` — per-currency + fleet-
 *   wide aggregate (`currency: null` for the fleet row).
 * - `GET /api/admin/cashback-realization/daily?days=N` — dense
 *   per-day per-currency time-series for the sparkline (every day
 *   in the window has a row so the sparkline doesn't compress on
 *   gap days).
 *
 * Type definitions live canonically in
 * `@loop/shared/admin-cashback-realization.ts` (per A2-1506); this
 * file re-exports them alongside the two functions.
 * `services/admin.ts` keeps the barrel so existing consumers
 * (`CashbackRealizationCard.tsx`, `RealizationSparkline.tsx` + paired
 * tests) don't have to re-target imports.
 */
import type {
  CashbackRealizationDailyResponse,
  CashbackRealizationDay,
  CashbackRealizationResponse,
  CashbackRealizationRow,
} from '@loop/shared';
import { authenticatedRequest } from './api-client';

export type {
  CashbackRealizationResponse,
  CashbackRealizationRow,
  CashbackRealizationDay,
  CashbackRealizationDailyResponse,
};

/** `GET /api/admin/cashback-realization` */
export async function getCashbackRealization(): Promise<CashbackRealizationResponse> {
  return authenticatedRequest<CashbackRealizationResponse>('/api/admin/cashback-realization');
}

/** `GET /api/admin/cashback-realization/daily?days=N` */
export async function getCashbackRealizationDaily(
  days?: number,
): Promise<CashbackRealizationDailyResponse> {
  const qs = days !== undefined ? `?days=${days}` : '';
  return authenticatedRequest<CashbackRealizationDailyResponse>(
    `/api/admin/cashback-realization/daily${qs}`,
  );
}
