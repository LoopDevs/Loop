/**
 * Admin reverse-lookup surface (ADR 037 — User 360 global search):
 *
 * - `GET /api/admin/lookup?q=…` — resolves an order id, payment
 *   memo, or Stellar address to the owning user / order. Email
 *   queries don't come here — the search box routes those to the
 *   existing `/api/admin/users?q=` directory search.
 *
 * Wire shape lives in `@loop/shared/admin-lookup.ts`.
 */
import type { AdminLookupResult } from '@loop/shared';
import { authenticatedRequest } from './api-client';

/** `GET /api/admin/lookup?q=…` */
export async function adminLookup(q: string): Promise<AdminLookupResult> {
  return authenticatedRequest<AdminLookupResult>(`/api/admin/lookup?q=${encodeURIComponent(q)}`);
}
