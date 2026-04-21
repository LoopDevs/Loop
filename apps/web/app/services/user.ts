/**
 * User-profile API (ADR 015).
 *
 * Thin wrappers over the backend's `/api/users/me*` surface. Kept
 * narrow — adding more profile fields later adds more functions
 * here rather than a single bloated "me" service.
 */
import { authenticatedRequest } from './api-client';

export interface UserMeView {
  id: string;
  email: string;
  isAdmin: boolean;
  homeCurrency: 'USD' | 'GBP' | 'EUR';
  stellarAddress: string | null;
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
