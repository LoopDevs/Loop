/**
 * `GET /api/public/merchants/:id` response shape (ADR 011 / 020).
 *
 * Unauthenticated single-merchant detail for SEO landing pages
 * (`/cashback/:merchant-slug` and friends). Backs the marketing
 * pitch for one merchant — "earn 5.5% cashback at Amazon" — with
 * a narrow, PII-free payload that can sit behind a CDN.
 *
 * ADR 020 rules:
 *   - Never emit PII: no per-user state, no commercial-terms
 *     fields (wholesale pct, margin pct). Only the user-facing
 *     pct a visitor sees.
 *   - Fields match `TopCashbackMerchant` where they overlap so
 *     a marketing page that lists top merchants and a merchant-
 *     detail page can share the same row-render component.
 *
 * ADR 019 three-part fit:
 * - Cross web ↔ backend boundary: backend emits, web renders.
 * - Pure TypeScript; no runtime deps.
 * - Drift = silent bug: a backend-only field change would leave
 *   SEO tiles with missing data.
 */
export interface PublicMerchantDetail {
  id: string;
  name: string;
  /** Marketing URL slug (same as `merchantSlug(name)` on the web side). */
  slug: string;
  logoUrl: string | null;
  /** numeric(5,2) as string, e.g. `"15.00"`. null when no active config — the "coming soon" SEO state. */
  userCashbackPct: string | null;
  /** ISO-8601 timestamp of when the snapshot was computed. */
  asOf: string;
}
