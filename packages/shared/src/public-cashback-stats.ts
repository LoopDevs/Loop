/**
 * `GET /api/public/cashback-stats` response shape (ADR 009 / 015 /
 * 020).
 *
 * Unauthenticated, CDN-friendly aggregate. Backend computes it from
 * the credit ledger + orders table and serves via the never-500
 * public-API discipline (last-known-good snapshot on DB error;
 * zero-shape on first-boot fallback).
 *
 * Shape is duplicated across the backend handler, the zod schema in
 * `openapi.ts`, and the web's `services/public-stats.ts`. This is the
 * ADR 019 single source of truth — the three sites each import from
 * here so drift becomes a compile error rather than a runtime shape
 * mismatch between what the DB emits and what the web reads.
 */

/**
 * Per-currency cashback total. `amountMinor` is bigint-as-string
 * (minor units) to survive JSON round-trip without precision loss
 * for fleet-wide aggregate sums.
 */
export interface PerCurrencyCashback {
  currency: string;
  amountMinor: string;
}

/** Whole `/api/public/cashback-stats` response body. */
export interface PublicCashbackStats {
  totalUsersWithCashback: number;
  totalCashbackByCurrency: PerCurrencyCashback[];
  fulfilledOrders: number;
  /** ISO-8601 timestamp of when the snapshot was computed. */
  asOf: string;
}
