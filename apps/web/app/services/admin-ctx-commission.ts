/**
 * Admin CTX operator-commission service (ctx-interop).
 *
 * - `GET /api/admin/ctx-commission` — CTX's record of the commission
 *   it owes Loop for attributed orders (per-currency balances +
 *   recent settlements), proxied by the backend with Loop's operator
 *   API credentials. The reconciliation counterpart to
 *   `admin-supplier-spend.ts` (Loop's own record of the traffic).
 *
 * Response shapes live in `@loop/shared/admin-ctx-commission.ts`.
 * Amounts are MAJOR-unit decimal strings exactly as CTX returns
 * them — not Loop's bigint-minor convention (see the shared type's
 * rationale).
 */
import type {
  AdminCtxCommissionResponse,
  CtxCommissionBalance,
  CtxCommissionSettlement,
} from '@loop/shared';
import { authenticatedRequest } from './api-client';

export type { AdminCtxCommissionResponse, CtxCommissionBalance, CtxCommissionSettlement };

/** `GET /api/admin/ctx-commission` — balances + recent settlements, or `configured: false`. */
export async function getCtxCommission(): Promise<AdminCtxCommissionResponse> {
  return authenticatedRequest<AdminCtxCommissionResponse>('/api/admin/ctx-commission');
}
