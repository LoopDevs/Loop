/**
 * `GET /api/public/cashback-preview` response shape (A2-676 +
 * ADR 019 + ADR 020).
 *
 * Unauthenticated pre-signup preview — a visitor enters a merchant
 * slug + an order amount, the endpoint reports the cashback they
 * would receive. No PII, no auth, CDN-cacheable.
 *
 * Shape was historically duplicated across
 * `apps/backend/src/public/cashback-preview.ts`,
 * `apps/backend/src/openapi.ts`, and
 * `apps/web/app/services/public-stats.ts` — three definitions
 * for one endpoint. Per ADR 019 the shared package is the single
 * source of truth. Each call site now imports from here so a field
 * rename is a compile-time error rather than a runtime shape
 * mismatch between what the backend emits and what the web
 * deserialises.
 */

/**
 * A `PublicCashbackPreview` is the response body of the public
 * cashback-preview endpoint. All numeric fields are minor-units
 * bigint-as-string so the wire format survives JSON round-trip
 * without precision loss.
 */
export interface PublicCashbackPreview {
  /** CTX merchant id (catalog-anchored stable identifier). */
  merchantId: string;
  /** Human-readable merchant name — surfaces in the calculator UI. */
  merchantName: string;
  /** Echo of the caller-supplied amount as bigint-as-string. */
  orderAmountMinor: string;
  /**
   * numeric(5,2) string (e.g. `"2.50"`). `null` when the merchant has
   * no active cashback config — the preview UI renders an em-dash then.
   */
  cashbackPct: string | null;
  /**
   * Computed cashback amount, floor-rounded. BigInt as string. `"0"`
   * when no config. Uses the same floor-rounded math as the order-
   * insert path so the preview never over-promises what the ledger
   * will write.
   */
  cashbackMinor: string;
  /**
   * Merchant's catalog currency — the same currency the ordering
   * flow would charge in (not the visitor's home currency, which
   * doesn't exist yet).
   */
  currency: string;
}
