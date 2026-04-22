/**
 * Response shapes for the unauthenticated /api/public/* endpoints.
 *
 * Kept here (rather than inlined on the handler file) so web + backend
 * share one declaration. Matches the pattern used for Merchant /
 * OrderStatus etc. — handlers stay free to refine their internal row
 * types, but the wire contract is imported from @loop/shared.
 *
 * All percentages are 2-decimal strings (e.g. "12.35"), matching the
 * `numeric(5,2)` Postgres shape that the rest of the cashback surface
 * uses (ADR 011). All minor-unit amounts are bigint-safe strings.
 */

/** `GET /api/public/cashback-stats` — headline aggregate for the landing page. */
export interface PublicCashbackStats {
  /** Count of active configs with user_cashback_pct > 0. */
  merchantsWithCashback: number;
  /** Average user_cashback_pct across those configs (2-decimal string). */
  averageCashbackPct: string;
  /** Max user_cashback_pct across those configs (2-decimal string). */
  topCashbackPct: string;
}

/** One entry in the `GET /api/public/top-cashback-merchants` list. */
export interface PublicTopCashbackMerchant {
  merchantId: string;
  /** Resolved from the upstream catalog at response time. */
  merchantName: string;
  /** Optional — omitted (not null) when the catalog entry has none. */
  logoUrl?: string | undefined;
  /** 2-decimal percent string, e.g. "18.00". */
  userCashbackPct: string;
}

/** Response envelope for the top-cashback-merchants endpoint. */
export interface PublicTopCashbackMerchantsResponse {
  merchants: PublicTopCashbackMerchant[];
}
