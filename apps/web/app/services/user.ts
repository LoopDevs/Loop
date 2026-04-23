/**
 * User-profile API (ADR 015).
 *
 * Thin wrappers over the backend's `/api/users/me*` surface. Kept
 * narrow — adding more profile fields later adds more functions
 * here rather than a single bloated "me" service.
 */
import { ApiException } from '@loop/shared';
import { authenticatedRequest } from './api-client';

export interface UserMeView {
  id: string;
  email: string;
  isAdmin: boolean;
  homeCurrency: 'USD' | 'GBP' | 'EUR';
  stellarAddress: string | null;
  /**
   * Off-chain cashback balance in `homeCurrency` minor units (pence /
   * cents). Returned as a string so the bigint round-trips through JSON
   * without precision loss. `"0"` when the user hasn't earned any
   * cashback yet.
   */
  homeCurrencyBalanceMinor: string;
}

/**
 * `POST /api/users/me/home-currency` — onboarding-time picker
 * (ADR 015). Server validates the currency against the enum and
 * returns 409 if the user has already placed an order. The
 * onboarding flow calls this pre-first-order so the 409 branch
 * is practically unreachable; callers still surface it as an
 * error rather than swallowing.
 */
export async function setHomeCurrency(code: 'USD' | 'GBP' | 'EUR'): Promise<UserMeView> {
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

/** One row of the credit-ledger history (ADR 009 / 015). */
export interface CashbackHistoryEntry {
  id: string;
  type: 'cashback' | 'interest' | 'spend' | 'withdrawal' | 'refund' | 'adjustment';
  /** Pence / cents in `currency`, as a bigint-string. */
  amountMinor: string;
  currency: string;
  /** Ledger-source tag (e.g. `'order'`), null when support-adjusted. */
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
}

export interface CashbackHistoryResponse {
  entries: CashbackHistoryEntry[];
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

export type UserPendingPayoutState = 'pending' | 'submitted' | 'confirmed' | 'failed';

/** One row of the caller's on-chain payout backlog (ADR 015 / 016). */
export interface UserPendingPayoutView {
  id: string;
  orderId: string;
  /** LOOP asset code: USDLOOP / GBPLOOP / EURLOOP. */
  assetCode: string;
  assetIssuer: string;
  /** Stroops (7 decimals); bigint-as-string. */
  amountStroops: string;
  state: UserPendingPayoutState;
  /** Null until the payout confirms on Stellar. */
  txHash: string | null;
  attempts: number;
  createdAt: string;
  submittedAt: string | null;
  confirmedAt: string | null;
  failedAt: string | null;
}

export interface UserPendingPayoutsResponse {
  payouts: UserPendingPayoutView[];
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

/**
 * Caller's pending-payouts summary (ADR 015 / 016). One row per
 * `(assetCode, state)` bucket; confirmed / failed states are
 * deliberately absent backend-side. Powers a "you have $X cashback
 * settling" chip without paging the full pending-payouts list.
 */
export interface UserPendingPayoutsSummaryRow {
  assetCode: string;
  state: 'pending' | 'submitted';
  count: number;
  /** Sum of amount_stroops in this bucket. BigInt as string. */
  totalStroops: string;
  /** ISO-8601 of the oldest row in the bucket. */
  oldestCreatedAt: string;
}

export interface UserPendingPayoutsSummaryResponse {
  rows: UserPendingPayoutsSummaryRow[];
}

/** `GET /api/users/me/pending-payouts/summary` */
export async function getUserPendingPayoutsSummary(): Promise<UserPendingPayoutsSummaryResponse> {
  return authenticatedRequest<UserPendingPayoutsSummaryResponse>(
    '/api/users/me/pending-payouts/summary',
  );
}

/**
 * Caller's LOOP-asset trustline status (ADR 015). One row per
 * configured LOOP asset; `present: true` means the user's linked
 * address already has the trustline so the next payout in that
 * asset will land. `accountLinked: false` → user hasn't linked a
 * wallet yet; `accountExists: false` → address is linked but not
 * yet funded on Stellar (needs an XLM reserve before any trustline
 * can be created).
 */
export interface StellarTrustlineRow {
  code: 'USDLOOP' | 'GBPLOOP' | 'EURLOOP';
  issuer: string;
  present: boolean;
  /** BigInt as string. `"0"` when absent. */
  balanceStroops: string;
  /** BigInt as string. `"0"` when absent. */
  limitStroops: string;
}

export interface StellarTrustlinesResponse {
  address: string | null;
  accountLinked: boolean;
  accountExists: boolean;
  rows: StellarTrustlineRow[];
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

/**
 * One row of the caller's off-chain credit balance (ADR 009 / 015).
 * Most users only ever have a single row in their home currency;
 * multi-currency users exist when an admin adjustment has been
 * applied in a non-home currency, or when the user has flipped
 * their home currency and the old bucket hasn't zeroed out yet.
 */
export interface UserCreditRow {
  currency: string;
  balanceMinor: string;
  updatedAt: string;
}

export interface UserCreditsResponse {
  credits: UserCreditRow[];
}

/** `GET /api/users/me/credits` — per-currency credit balances. */
export async function getMyCredits(): Promise<UserCreditsResponse> {
  return authenticatedRequest<UserCreditsResponse>('/api/users/me/credits');
}

/**
 * Compact cashback summary — all-time + this-month totals in the
 * caller's home currency. Powers the mobile home headline
 * ("£42 lifetime · £3.20 this month") without paging the ledger.
 * Both totals are `type='cashback'` rows only, so spend /
 * withdrawal / adjustment don't muddy the earnings number.
 */
export interface UserCashbackSummary {
  currency: string;
  lifetimeMinor: string;
  thisMonthMinor: string;
}

/** `GET /api/users/me/cashback-summary` */
export async function getCashbackSummary(): Promise<UserCashbackSummary> {
  return authenticatedRequest<UserCashbackSummary>('/api/users/me/cashback-summary');
}

/**
 * One row of the caller's cashback-by-merchant breakdown (ADR 009 / 015).
 * `merchantId` is the catalog slug — the client resolves display
 * name via the in-memory merchant catalog instead of round-tripping
 * another lookup per row.
 */
export interface CashbackByMerchantRow {
  merchantId: string;
  cashbackMinor: string;
  orderCount: number;
  lastEarnedAt: string;
}

export interface CashbackByMerchantResponse {
  currency: string;
  since: string;
  rows: CashbackByMerchantRow[];
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

/** One month × currency aggregate from GET /api/users/me/cashback-monthly. */
export interface CashbackMonthlyEntry {
  /** "YYYY-MM" in UTC. */
  month: string;
  currency: string;
  /** bigint-as-string, minor units. */
  cashbackMinor: string;
}

export interface CashbackMonthlyResponse {
  entries: CashbackMonthlyEntry[];
}

/**
 * `GET /api/users/me/cashback-monthly` — last 12 calendar months of
 * cashback totals grouped by (month, currency). Drives the monthly
 * bar chart on /settings/cashback.
 */
export async function getCashbackMonthly(): Promise<CashbackMonthlyResponse> {
  return authenticatedRequest<CashbackMonthlyResponse>('/api/users/me/cashback-monthly');
}

/** 5-number summary from GET /api/users/me/orders/summary (ADR 010 / 015). */
export interface UserOrdersSummary {
  currency: string;
  totalOrders: number;
  fulfilledCount: number;
  /** pending_payment + paid + procuring — all "in flight" states. */
  pendingCount: number;
  /** failed + expired — both "didn't succeed". */
  failedCount: number;
  /** SUM(charge_minor) over state='fulfilled' only — bigint-as-string. */
  totalSpentMinor: string;
}

/**
 * `GET /api/users/me/orders/summary` — compact 5-number header for
 * the /orders page. One round-trip: totals across states + lifetime
 * spend in the user's home currency.
 */
export async function getUserOrdersSummary(): Promise<UserOrdersSummary> {
  return authenticatedRequest<UserOrdersSummary>('/api/users/me/orders/summary');
}

/**
 * Personal flywheel scalar (ADR 015). How many of the caller's
 * fulfilled orders were paid with a LOOP asset (recycled cashback),
 * vs the total-fulfilled denominator in the same home currency.
 * Powers a motivational chip on /orders — user-side mirror of the
 * admin `payment-method-share` signal.
 */
export interface UserFlywheelStats {
  currency: string;
  recycledOrderCount: number;
  /** SUM(charge_minor) over loop_asset orders. bigint-as-string. */
  recycledChargeMinor: string;
  totalFulfilledCount: number;
  /** SUM(charge_minor) over every fulfilled order in home_currency. bigint-as-string. */
  totalFulfilledChargeMinor: string;
}

/** `GET /api/users/me/flywheel-stats` — scalar recycled-vs-total snapshot. */
export async function getUserFlywheelStats(): Promise<UserFlywheelStats> {
  return authenticatedRequest<UserFlywheelStats>('/api/users/me/flywheel-stats');
}

/**
 * Personal rail-mix snapshot (#643). Caller's own
 * orders-by-payment-method for their home currency. Drives the
 * "your rail mix" card on /settings/cashback — a user who sees
 * their own LOOP share at 0% gets the clearest app-facing
 * nudge toward ADR 015's compounding flywheel.
 *
 * Same shape as the admin + fleet rail-mix siblings, keyed on
 * the auth context rather than a URL param.
 */
export type UserPaymentMethod = 'xlm' | 'usdc' | 'credit' | 'loop_asset';
export type UserOrderState =
  | 'pending_payment'
  | 'paid'
  | 'procuring'
  | 'fulfilled'
  | 'failed'
  | 'expired';

export interface UserPaymentMethodBucket {
  orderCount: number;
  /** SUM(charge_minor) for this (state, method) bucket. bigint-as-string. */
  chargeMinor: string;
}

export interface UserPaymentMethodShareResponse {
  currency: string;
  state: UserOrderState;
  totalOrders: number;
  byMethod: Record<UserPaymentMethod, UserPaymentMethodBucket>;
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
