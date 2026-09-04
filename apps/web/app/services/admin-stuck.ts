/**
 * A2-1165 (slice 11): admin stuck-payouts surface extracted from
 * `services/admin.ts`. One read backs the safety-critical alerting
 * card on the admin dashboard:
 *
 * - `GET /api/admin/stuck-payouts` — `pending_payouts` rows in
 *   `pending` or `submitted` past the SLO (ADR 015 / 016). Payouts
 *   stuck in Stellar submission. (The stuck-orders sibling retired
 *   with ADR 052 — ctx owns order fulfilment, so there is no
 *   Loop-side procurement pipeline left to stall.)
 *
 * The `StuckPayoutRow` / `StuckPayoutsResponse` shapes were inline
 * in `services/admin.ts` and move with the functions. They have no
 * other consumers, so promoting them to `@loop/shared` would just
 * add indirection. `services/admin.ts` keeps a barrel re-export so
 * existing consumers (`StuckPayoutsCard.tsx` + paired tests) don't
 * have to re-target imports.
 */
import { authenticatedRequest } from './api-client';

/** Single stuck-payout row (ADR 015 / 016). */
export interface StuckPayoutRow {
  id: string;
  userId: string;
  orderId: string;
  assetCode: string;
  /** Bigint-as-string stroops (7 decimals). */
  amountStroops: string;
  state: string;
  /** ISO timestamp keyed by submitted_at (submitted) or created_at (pending). */
  stuckSince: string;
  ageMinutes: number;
  attempts: number;
}

export interface StuckPayoutsResponse {
  thresholdMinutes: number;
  rows: StuckPayoutRow[];
}

/** `GET /api/admin/stuck-payouts` — pending_payouts past the SLO. */
export async function getStuckPayouts(): Promise<StuckPayoutsResponse> {
  return authenticatedRequest<StuckPayoutsResponse>('/api/admin/stuck-payouts');
}
