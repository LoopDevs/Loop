/**
 * User-profile API (ADR 015).
 *
 * Thin wrappers over the backend's `/api/users/me*` surface.
 *
 * A2-1505: every response shape lives in `@loop/shared/users-me.ts`
 * (ADR 019). This module only holds fetcher functions + local
 * re-exports so existing call sites import from `~/services/user`
 * unchanged.
 */
import { ApiException } from '@loop/shared';
import type {
  CashbackByMerchantResponse,
  CashbackByMerchantRow,
  CashbackHistoryEntry,
  CashbackHistoryResponse,
  CashbackMonthlyEntry,
  CashbackMonthlyResponse,
  StellarTrustlineRow,
  StellarTrustlinesResponse,
  UserCashbackSummary,
  UserCreditRow,
  UserCreditsResponse,
  UserFlywheelStats,
  UserMeView,
  UserOrdersSummary,
  UserPaymentMethodBucket,
  UserPaymentMethodShareResponse,
  UserPendingPayoutState,
  UserPendingPayoutView,
  UserPendingPayoutsResponse,
  UserPendingPayoutsSummaryResponse,
  UserPendingPayoutsSummaryRow,
  HomeCurrency,
  OrderPaymentMethod,
  OrderState,
} from '@loop/shared';
import { authenticatedRequest } from './api-client';

// A2-1505 re-exports. Types stayed importable from `~/services/user`
// so 70+ component/test call sites don't fan out a rename.
export type {
  CashbackByMerchantResponse,
  CashbackByMerchantRow,
  CashbackHistoryEntry,
  CashbackHistoryResponse,
  CashbackMonthlyEntry,
  CashbackMonthlyResponse,
  StellarTrustlineRow,
  StellarTrustlinesResponse,
  UserCashbackSummary,
  UserCreditRow,
  UserCreditsResponse,
  UserFlywheelStats,
  UserMeView,
  UserOrdersSummary,
  UserPaymentMethodBucket,
  UserPaymentMethodShareResponse,
  UserPendingPayoutState,
  UserPendingPayoutView,
  UserPendingPayoutsResponse,
  UserPendingPayoutsSummaryResponse,
  UserPendingPayoutsSummaryRow,
};

// Legacy web-side aliases retained for call-site stability.
export type UserPaymentMethod = OrderPaymentMethod;
export type UserOrderState = OrderState;

/**
 * `POST /api/users/me/home-currency` — onboarding-time picker
 * (ADR 015). Server validates the currency against the enum and
 * returns 409 if the user has already placed an order. The
 * onboarding flow calls this pre-first-order so the 409 branch
 * is practically unreachable; callers still surface it as an
 * error rather than swallowing.
 */
export async function setHomeCurrency(code: HomeCurrency): Promise<UserMeView> {
  return authenticatedRequest<UserMeView>('/api/users/me/home-currency', {
    method: 'POST',
    body: { currency: code },
  });
}

/** `GET /api/users/me` — full profile. Used by settings pages. */
export async function getMe(): Promise<UserMeView> {
  return authenticatedRequest<UserMeView>('/api/users/me');
}

/**
 * `PUT /api/users/me/stellar-address` — link or unlink the user's
 * Stellar wallet (ADR 015). `null` unlinks. Server validates the
 * address against Stellar's pubkey format and returns 400 on
 * malformed input.
 */
export async function setStellarAddress(address: string | null): Promise<UserMeView> {
  return authenticatedRequest<UserMeView>('/api/users/me/stellar-address', {
    method: 'PUT',
    body: { address },
  });
}

/**
 * `GET /api/users/me/cashback-history` — caller's recent ledger
 * events, newest first. Pass `before` (ISO timestamp) + `limit` for
 * pagination; both are optional.
 */
export async function getCashbackHistory(
  opts: { limit?: number; before?: string } = {},
): Promise<CashbackHistoryResponse> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.before !== undefined) params.set('before', opts.before);
  const query = params.toString();
  return authenticatedRequest<CashbackHistoryResponse>(
    `/api/users/me/cashback-history${query.length > 0 ? `?${query}` : ''}`,
  );
}

/**
 * `GET /api/users/me/pending-payouts` — caller-scoped on-chain payout
 * backlog. Mirrors the admin shape (state / before / limit) but
 * filtered to `auth.userId` server-side. Rendered on /settings/cashback
 * so the user can track each outbound LOOP-asset emission.
 */
export async function getUserPendingPayouts(
  opts: { state?: UserPendingPayoutState; limit?: number; before?: string } = {},
): Promise<UserPendingPayoutsResponse> {
  const params = new URLSearchParams();
  if (opts.state !== undefined) params.set('state', opts.state);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.before !== undefined) params.set('before', opts.before);
  const query = params.toString();
  return authenticatedRequest<UserPendingPayoutsResponse>(
    `/api/users/me/pending-payouts${query.length > 0 ? `?${query}` : ''}`,
  );
}

/** `GET /api/users/me/pending-payouts/summary` */
export async function getUserPendingPayoutsSummary(): Promise<UserPendingPayoutsSummaryResponse> {
  return authenticatedRequest<UserPendingPayoutsSummaryResponse>(
    '/api/users/me/pending-payouts/summary',
  );
}

/** `GET /api/users/me/stellar-trustlines` */
export async function getUserStellarTrustlines(): Promise<StellarTrustlinesResponse> {
  return authenticatedRequest<StellarTrustlinesResponse>('/api/users/me/stellar-trustlines');
}

/**
 * `GET /api/users/me/orders/:orderId/payout` — per-order
 * settlement drill. Returns the single pending-payout row tied
 * to one of the caller's own orders, or null when there isn't
 * one (cashback not yet minted, order not fulfilled, or the user
 * doesn't own the order). Cross-user access returns 404 server-
 * side so we turn that into null here to keep call sites simple.
 */
export async function getUserPayoutByOrder(orderId: string): Promise<UserPendingPayoutView | null> {
  try {
    return await authenticatedRequest<UserPendingPayoutView>(
      `/api/users/me/orders/${encodeURIComponent(orderId)}/payout`,
    );
  } catch (err) {
    if (err instanceof ApiException && err.status === 404) return null;
    throw err;
  }
}

/** `GET /api/users/me/credits` — per-currency credit balances. */
export async function getMyCredits(): Promise<UserCreditsResponse> {
  return authenticatedRequest<UserCreditsResponse>('/api/users/me/credits');
}

/** `GET /api/users/me/cashback-summary` */
export async function getCashbackSummary(): Promise<UserCashbackSummary> {
  return authenticatedRequest<UserCashbackSummary>('/api/users/me/cashback-summary');
}

/**
 * `GET /api/users/me/cashback-by-merchant` — top merchants by cashback
 * earned in a rolling window. Default 180d window; server clamps
 * `?since=` to 366d and `?limit=` to 50.
 */
export async function getCashbackByMerchant(
  opts: { since?: string; limit?: number } = {},
): Promise<CashbackByMerchantResponse> {
  const params = new URLSearchParams();
  if (opts.since !== undefined) params.set('since', opts.since);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return authenticatedRequest<CashbackByMerchantResponse>(
    `/api/users/me/cashback-by-merchant${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/**
 * `GET /api/users/me/cashback-monthly` — last 12 calendar months of
 * cashback totals grouped by (month, currency). Drives the monthly
 * bar chart on /settings/cashback.
 */
export async function getCashbackMonthly(): Promise<CashbackMonthlyResponse> {
  return authenticatedRequest<CashbackMonthlyResponse>('/api/users/me/cashback-monthly');
}

/**
 * `GET /api/users/me/orders/summary` — compact 5-number header for
 * the /orders page. One round-trip: totals across states + lifetime
 * spend in the user's home currency.
 */
export async function getUserOrdersSummary(): Promise<UserOrdersSummary> {
  return authenticatedRequest<UserOrdersSummary>('/api/users/me/orders/summary');
}

/** `GET /api/users/me/flywheel-stats` — scalar recycled-vs-total snapshot. */
export async function getUserFlywheelStats(): Promise<UserFlywheelStats> {
  return authenticatedRequest<UserFlywheelStats>('/api/users/me/flywheel-stats');
}

/** `GET /api/users/me/payment-method-share` — caller's own rail mix. */
export async function getUserPaymentMethodShare(
  opts: { state?: UserOrderState } = {},
): Promise<UserPaymentMethodShareResponse> {
  const params = new URLSearchParams();
  if (opts.state !== undefined) params.set('state', opts.state);
  const qs = params.toString();
  return authenticatedRequest<UserPaymentMethodShareResponse>(
    `/api/users/me/payment-method-share${qs.length > 0 ? `?${qs}` : ''}`,
  );
}
