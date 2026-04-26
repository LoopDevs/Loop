/**
 * A2-1165 (slice 11): admin stuck-orders + stuck-payouts surface
 * extracted from `services/admin.ts`. Two reads back the safety-
 * critical alerting cards on the admin dashboard:
 *
 * - `GET /api/admin/stuck-orders` — orders sitting past the SLO
 *   in `paid` or `procuring` (ADR 011 / 013). Polls flag potential
 *   supplier incidents before users notice. `paymentMethod`
 *   matters for triage — a stuck `loop_asset` is a flywheel-path
 *   incident, `xlm`/`usdc` is a Stellar-watcher incident,
 *   `credit` is an off-ledger state-machine bug.
 * - `GET /api/admin/stuck-payouts` — `pending_payouts` rows in
 *   `pending` or `submitted` past the SLO (ADR 015 / 016). Same
 *   dashboard poll cadence as stuck-orders. Complements it:
 *   orders stuck in CTX procurement, payouts stuck in Stellar
 *   submission.
 *
 * The `StuckOrderRow` / `StuckOrdersResponse` / `StuckPayoutRow`
 * / `StuckPayoutsResponse` shapes were inline in
 * `services/admin.ts` and move with the functions. They have no
 * other consumers, so promoting them to `@loop/shared` would just
 * add indirection. `services/admin.ts` keeps a barrel re-export so
 * existing consumers (`StuckOrdersCard.tsx`, `StuckPayoutsCard.tsx`,
 * `routes/admin.dashboard.tsx`, paired tests) don't have to
 * re-target imports.
 */
import { authenticatedRequest } from './api-client';

/** Single stuck-order row (ADR 011 / 013). */
export interface StuckOrderRow {
  id: string;
  userId: string;
  merchantId: string;
  state: string;
  /**
   * Payment rail the user chose (ADR 015). Matters for triage — a
   * stuck `loop_asset` order is a flywheel-path incident; a stuck
   * `xlm`/`usdc` is a Stellar-watcher incident; a stuck `credit` is
   * an off-ledger state-machine bug.
   */
  paymentMethod: string;
  /** ISO timestamp keyed by paid_at or procured_at depending on state. */
  stuckSince: string;
  /** Elapsed minutes since stuckSince. */
  ageMinutes: number;
  ctxOrderId: string | null;
  ctxOperatorId: string | null;
}

export interface StuckOrdersResponse {
  thresholdMinutes: number;
  rows: StuckOrderRow[];
}

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

/** `GET /api/admin/stuck-orders` — orders past the SLO in paid/procuring. */
export async function getStuckOrders(): Promise<StuckOrdersResponse> {
  return authenticatedRequest<StuckOrdersResponse>('/api/admin/stuck-orders');
}

/** `GET /api/admin/stuck-payouts` — pending_payouts past the SLO. */
export async function getStuckPayouts(): Promise<StuckPayoutsResponse> {
  return authenticatedRequest<StuckPayoutsResponse>('/api/admin/stuck-payouts');
}
