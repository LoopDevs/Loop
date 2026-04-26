/**
 * A2-1165 (slice 6): admin supplier-spend surface extracted
 * from `services/admin.ts`. Two reads cover what Loop owes CTX
 * (ADR 013 / 015):
 *
 * - `GET /api/admin/supplier-spend` — per-currency aggregate of
 *   wholesale + the user-cashback / loop-margin counts that fell
 *   out of those orders. Default window 24h, server clamps
 *   `?since=<iso>` to 366d.
 * - `GET /api/admin/supplier-spend/activity` — per-day per-currency
 *   time-axis of the same row shape (zero-filled when
 *   `?currency=USD|GBP|EUR` is passed so charts don't compress).
 *
 * Type definitions live canonically in
 * `@loop/shared/admin-supplier-spend.ts` (per A2-1506); this file
 * re-exports them alongside the two functions. `services/admin.ts`
 * keeps the barrel so existing consumers
 * (`SupplierSpendCard.tsx`, `SupplierSpendActivityCard.tsx` +
 * paired tests, `routes/admin.supplier-spend.tsx`) don't have to
 * re-target imports.
 */
import type {
  SupplierSpendActivityDay,
  SupplierSpendActivityResponse,
  SupplierSpendResponse,
  SupplierSpendRow,
} from '@loop/shared';
import { authenticatedRequest } from './api-client';

export type {
  SupplierSpendRow,
  SupplierSpendResponse,
  SupplierSpendActivityDay,
  SupplierSpendActivityResponse,
};

/** `GET /api/admin/supplier-spend` — pass `?since=<iso>` to override the 24h default. */
export async function getSupplierSpend(
  opts: { since?: string } = {},
): Promise<SupplierSpendResponse> {
  const params = new URLSearchParams();
  if (opts.since !== undefined) params.set('since', opts.since);
  const qs = params.toString();
  return authenticatedRequest<SupplierSpendResponse>(
    `/api/admin/supplier-spend${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/** `GET /api/admin/supplier-spend/activity` — pass `?currency=` to zero-fill days. */
export async function getSupplierSpendActivity(
  opts: { days?: number; currency?: 'USD' | 'GBP' | 'EUR' } = {},
): Promise<SupplierSpendActivityResponse> {
  const params = new URLSearchParams();
  if (opts.days !== undefined) params.set('days', String(opts.days));
  if (opts.currency !== undefined) params.set('currency', opts.currency);
  const qs = params.toString();
  return authenticatedRequest<SupplierSpendActivityResponse>(
    `/api/admin/supplier-spend/activity${qs.length > 0 ? `?${qs}` : ''}`,
  );
}
