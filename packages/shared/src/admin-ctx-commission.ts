/**
 * Admin CTX operator-commission response shapes (ctx-interop).
 *
 * Loop is a first-class operator company on CTX. CTX accrues a
 * per-order commission (the spread between Loop's operatorDiscount
 * and the consumer userDiscount, snapshotted on the gift card at
 * creation) into a per-currency operator balance, settled by CTX on
 * a schedule. `GET /api/admin/ctx-commission` proxies CTX's
 * `GET /companies/:id/commission` (+ recent settlements) so ops can
 * see the accrued balance and reconcile settlements against Loop's
 * own `supplier-spend` records without leaving the admin panel.
 *
 * All amounts are MAJOR-unit decimal strings exactly as CTX returns
 * them (e.g. "1.50") — deliberately NOT Loop's bigint-minor-string
 * convention, because these are CTX-authored numbers being surfaced
 * for reconciliation; reformatting them here would hide drift.
 */

/** One per-currency unsettled-commission balance row from CTX. */
export interface CtxCommissionBalance {
  currency: string;
  /** Major-unit decimal string, as returned by CTX. */
  amount: string;
  /** Unsettled ledger entries backing the balance. */
  entryCount: number;
}

/** One CTX commission settlement (payout grouping) row. */
export interface CtxCommissionSettlement {
  id: string;
  /** Major-unit decimal string, as returned by CTX. */
  amount: string;
  currency: string;
  /** ISO-8601 — half-open period this settlement covers. */
  periodStart: string;
  periodEnd: string;
  /** Gift cards whose commission entries were settled — the traceability link. */
  giftCardIds: string[];
  entryCount: number;
  created: string;
}

/**
 * Full response shape for `GET /api/admin/ctx-commission`.
 *
 * `configured: false` (with every other field absent) means the
 * backend is missing the CTX API credentials —
 * a deployment state, not an error, so it's a 200 and the admin UI
 * renders a "not configured" hint instead of an error card.
 */
export interface AdminCtxCommissionResponse {
  configured: boolean;
  companyId?: string;
  balances?: CtxCommissionBalance[];
  lastSettlementAt?: string;
  settlements?: CtxCommissionSettlement[];
}
