/**
 * Admin reverse-lookup surface (ADR 037 — User 360 global search):
 *
 * - `GET /api/admin/lookup?q=…` — resolves an order id, payment
 *   memo, or Stellar address to the owning user / order. Email
 *   queries don't come here — the search box routes those to the
 *   existing `/api/admin/users?q=` directory search.
 *
 * A well-formed identifier with no match is a 404 (`NOT_FOUND`) per
 * the uniform admin convention — callers branch on the ApiException
 * status, not a `kind: 'none'` sentinel.
 *
 * Wire shape lives in `@loop/shared/admin-support-ops.ts`.
 */
import type { AdminLookupResponse } from '@loop/shared';
import { authenticatedRequest } from './api-client';

/** `GET /api/admin/lookup?q=…` */
export async function adminLookup(q: string): Promise<AdminLookupResponse> {
  return authenticatedRequest<AdminLookupResponse>(`/api/admin/lookup?q=${encodeURIComponent(q)}`);
}
