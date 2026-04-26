/**
 * A2-1165 (slice 7): admin operator-mix-axis surface extracted
 * from `services/admin.ts`. Three reads cover the ADR 023 mix-
 * axis matrix — every row is a (subject, operator) pair and only
 * the subject changes across the three:
 *
 * - `GET /api/admin/merchants/:merchantId/operator-mix` —
 *   merchant-scoped (which CTX operators are carrying this
 *   merchant's orders).
 * - `GET /api/admin/operators/:operatorId/merchant-mix` —
 *   operator-scoped dual (which merchants is this operator
 *   carrying).
 * - `GET /api/admin/users/:userId/operator-mix` — user-scoped
 *   (third corner; used for support triage when a single user's
 *   slow cashback correlates with one operator's circuit).
 *
 * Type definitions live canonically in
 * `@loop/shared/admin-operator-mixes.ts` (per A2-1506); this
 * file re-exports them alongside the three functions.
 * `services/admin.ts` keeps the barrel so existing consumers
 * (admin merchant/operator/user drill pages and their paired
 * tests) don't have to re-target imports.
 */
import type {
  MerchantOperatorMixResponse,
  MerchantOperatorMixRow,
  OperatorMerchantMixResponse,
  OperatorMerchantMixRow,
  UserOperatorMixResponse,
  UserOperatorMixRow,
} from '@loop/shared';
import { authenticatedRequest } from './api-client';

export type {
  MerchantOperatorMixResponse,
  MerchantOperatorMixRow,
  OperatorMerchantMixResponse,
  OperatorMerchantMixRow,
  UserOperatorMixResponse,
  UserOperatorMixRow,
};

/** `GET /api/admin/merchants/:merchantId/operator-mix` — server clamps `?since=` at 366d. */
export async function getMerchantOperatorMix(
  merchantId: string,
  opts: { since?: string } = {},
): Promise<MerchantOperatorMixResponse> {
  const params = new URLSearchParams();
  if (opts.since !== undefined) params.set('since', opts.since);
  const qs = params.toString();
  return authenticatedRequest<MerchantOperatorMixResponse>(
    `/api/admin/merchants/${encodeURIComponent(merchantId)}/operator-mix${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/** `GET /api/admin/operators/:operatorId/merchant-mix` — server clamps `?since=` at 366d. */
export async function getOperatorMerchantMix(
  operatorId: string,
  opts: { since?: string } = {},
): Promise<OperatorMerchantMixResponse> {
  const params = new URLSearchParams();
  if (opts.since !== undefined) params.set('since', opts.since);
  const qs = params.toString();
  return authenticatedRequest<OperatorMerchantMixResponse>(
    `/api/admin/operators/${encodeURIComponent(operatorId)}/merchant-mix${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/** `GET /api/admin/users/:userId/operator-mix` — server clamps `?since=` at 366d. */
export async function getUserOperatorMix(
  userId: string,
  opts: { since?: string } = {},
): Promise<UserOperatorMixResponse> {
  const params = new URLSearchParams();
  if (opts.since !== undefined) params.set('since', opts.since);
  const qs = params.toString();
  return authenticatedRequest<UserOperatorMixResponse>(
    `/api/admin/users/${encodeURIComponent(userId)}/operator-mix${qs.length > 0 ? `?${qs}` : ''}`,
  );
}
