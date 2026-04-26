/**
 * A2-1165 (slice 4): admin treasury surface extracted from
 * `services/admin.ts`. The treasury domain (ADR 015) covers two
 * reads:
 *
 * - `GET /api/admin/treasury` — point-in-time snapshot (LOOP
 *   liabilities + holdings + the latest order flow row).
 * - `GET /api/admin/treasury/credit-flow` — per-day per-currency
 *   ledger delta time-series for the credit-flow chart.
 *
 * Type definitions live canonically in `@loop/shared/admin-treasury.ts`
 * (per A2-1506); this file re-exports them alongside the two read
 * functions. `services/admin.ts` keeps the barrel so existing
 * consumers (AdminNav.tsx, CreditFlowChart.tsx, routes/admin.assets
 * .tsx + paired tests, etc.) don't have to re-target imports.
 */
import type {
  LoopLiability,
  PayoutState,
  TreasuryCreditFlowDay,
  TreasuryCreditFlowResponse,
  TreasuryHolding,
  TreasuryOrderFlow,
  TreasurySnapshot,
} from '@loop/shared';
import { authenticatedRequest } from './api-client';

export type {
  PayoutState,
  LoopLiability,
  TreasuryHolding,
  TreasuryOrderFlow,
  TreasurySnapshot,
  TreasuryCreditFlowDay,
  TreasuryCreditFlowResponse,
};

/** GET /api/admin/treasury */
export async function getTreasurySnapshot(): Promise<TreasurySnapshot> {
  return authenticatedRequest<TreasurySnapshot>('/api/admin/treasury');
}

/**
 * `GET /api/admin/treasury/credit-flow` — per-day per-currency
 * ledger delta. Pass `?currency=USD|GBP|EUR` to zero-fill days
 * (stable chart layout).
 */
export async function getTreasuryCreditFlow(
  opts: { days?: number; currency?: 'USD' | 'GBP' | 'EUR' } = {},
): Promise<TreasuryCreditFlowResponse> {
  const params = new URLSearchParams();
  if (opts.days !== undefined) params.set('days', String(opts.days));
  if (opts.currency !== undefined) params.set('currency', opts.currency);
  const qs = params.toString();
  return authenticatedRequest<TreasuryCreditFlowResponse>(
    `/api/admin/treasury/credit-flow${qs.length > 0 ? `?${qs}` : ''}`,
  );
}
