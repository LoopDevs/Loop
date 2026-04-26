/**
 * A2-1165 (slice 27): admin settlement-lag SLA read extracted
 * from `services/admin.ts`. Single read for the on-chain payout
 * latency dashboard card (ADR 015 / 016):
 *
 * - `GET /api/admin/payouts/settlement-lag?since=<iso>` —
 *   percentile latency in seconds from `pending_payouts` insert
 *   → on-chain confirm. Fleet-wide row surfaces with
 *   `assetCode: null`; per-asset rows carry the LOOP code.
 *   Sample count ships alongside so callers can down-weight
 *   low-n rows (p95 of n=1 is noise).
 *
 * Type definitions live canonically in
 * `@loop/shared/admin-settlement-lag.ts` (per A2-1506); this
 * file re-exports them alongside the read function.
 * `services/admin.ts` keeps a barrel re-export so existing
 * consumers (`SettlementLagCard.tsx`, paired test) don't have
 * to re-target imports.
 */
import type { SettlementLagResponse, SettlementLagRow } from '@loop/shared';
import { authenticatedRequest } from './api-client';

export type { SettlementLagResponse, SettlementLagRow };

/** `GET /api/admin/payouts/settlement-lag?since=<iso>` — pass an ISO override or omit for the default window. */
export async function getSettlementLag(sinceIso?: string): Promise<SettlementLagResponse> {
  const qs = sinceIso !== undefined ? `?since=${encodeURIComponent(sinceIso)}` : '';
  return authenticatedRequest<SettlementLagResponse>(`/api/admin/payouts/settlement-lag${qs}`);
}
