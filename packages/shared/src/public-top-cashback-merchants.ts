/**
 * `GET /api/public/top-cashback-merchants` response shape (ADR 011 /
 * 020).
 *
 * CDN-friendly "best cashback" list for the landing page. Backend
 * joins the active `merchant_cashback_configs` pct against the
 * in-memory merchant catalog; the response is never-500 (last-known-
 * good snapshot on DB trouble, empty list on bootstrap). Marketing
 * and authenticated surfaces both read this shape, so it sits in
 * `@loop/shared` alongside the admin-side config types.
 *
 * ADR 019 three-part fit:
 * - Cross web ↔ backend boundary — backend emits, web renders.
 * - Pure TypeScript — no Node APIs, no deps.
 * - Drift = silent bug — adding a field on the backend without the
 *   web knowing leaves marketing tiles with missing data.
 */

/**
 * One entry in the top-cashback-merchants list. Kept narrow — this
 * is an unauthenticated marketing surface (ADR 020 rule 6), so only
 * fields a landing tile needs. No commercial terms (wholesale,
 * margin) exposed; only the user-facing pct.
 */
export interface TopCashbackMerchant {
  id: string;
  name: string;
  logoUrl: string | null;
  /** numeric(5,2) as string, e.g. `"15.00"`. */
  userCashbackPct: string;
}

export interface PublicTopCashbackMerchantsResponse {
  merchants: TopCashbackMerchant[];
  /** ISO-8601 timestamp of when the snapshot was computed. */
  asOf: string;
}
