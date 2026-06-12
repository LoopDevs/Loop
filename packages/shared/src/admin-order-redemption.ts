/**
 * `POST /api/admin/orders/:orderId/refetch-redemption` wire shape
 * (ADR 037 — order delivery panel). Re-runs the CTX redemption fetch
 * for a fulfilled order whose redeem URL/code/PIN came back null —
 * the known fulfilled-null gap from the Phase-1 e2e validation. A
 * support-allowed delivery-unsticking action (ADR 037 §3).
 */
export interface AdminRefetchRedemptionResult {
  /** True when a fresh CTX fetch was actually performed. */
  refetched: boolean;
  /** Whether redemption material is present after the (re)fetch. */
  redemptionPresent: boolean;
}
