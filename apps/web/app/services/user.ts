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
import type {
  CashbackByMerchantResponse,
  CashbackByMerchantRow,
  CashbackHistoryEntry,
  CashbackHistoryResponse,
  CashbackMonthlyEntry,
  CashbackMonthlyResponse,
  UserCashbackSummary,
  UserMeView,
  UserOrdersSummary,
  UserAccountView,
  WalletLinkView,
  LinkWalletRequest,
  UpdateWalletRequest,
  HomeCurrency,
  OrderState,
} from '@loop/shared';
import { authenticatedRequest } from './api-client';

// A2-1505 re-exports. Types stayed importable from `~/services/user`
// so 70+ component/test call sites don't fan out a rename.
export type {
  UserAccountView,
  WalletLinkView,
  LinkWalletRequest,
  UpdateWalletRequest,
  CashbackByMerchantResponse,
  CashbackByMerchantRow,
  CashbackHistoryEntry,
  CashbackHistoryResponse,
  CashbackMonthlyEntry,
  CashbackMonthlyResponse,
  UserCashbackSummary,
  UserMeView,
  UserOrdersSummary,
};

// Legacy web-side alias retained for call-site stability.
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

export async function getMyAccount(): Promise<UserAccountView> {
  return authenticatedRequest<UserAccountView>('/api/users/me/account');
}

export async function linkWallet(body: LinkWalletRequest): Promise<WalletLinkView> {
  return authenticatedRequest<WalletLinkView>('/api/users/me/wallets', {
    method: 'POST',
    body,
  });
}

export async function updateWallet(
  walletId: string,
  body: UpdateWalletRequest,
): Promise<WalletLinkView> {
  return authenticatedRequest<WalletLinkView>(
    `/api/users/me/wallets/${encodeURIComponent(walletId)}`,
    { method: 'PUT', body },
  );
}

export async function unlinkWallet(walletId: string): Promise<WalletLinkView> {
  return authenticatedRequest<WalletLinkView>(
    `/api/users/me/wallets/${encodeURIComponent(walletId)}`,
    { method: 'DELETE' },
  );
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

// ─── DSR: data export / account deletion (CF-26 / X-PRIV-01) ─────────────────
// GDPR Art. 15/17 + Apple App Store Guideline 5.1.1(v). The backend
// primitives already exist (`apps/backend/src/users/dsr-export.ts` +
// `dsr-delete.ts`); these wire them to the in-app privacy screen.

/**
 * `GET /api/users/me/dsr/export` — full machine-readable export of
 * every row Loop holds keyed to the caller. Returns the parsed JSON
 * envelope; `downloadMyData` wraps this to push it as a file. Redeem
 * codes/PINs are intentionally excluded server-side (shown only as a
 * boolean) — see the backend module header.
 */
export async function getMyDataExport(): Promise<unknown> {
  return authenticatedRequest<unknown>('/api/users/me/dsr/export');
}

/**
 * Fetches the DSR export and triggers a browser download of the JSON.
 * Web-only convenience (uses DOM APIs); the caller gates it behind a
 * platform check. Returns once the click has been dispatched.
 */
export async function downloadMyData(): Promise<void> {
  const payload = await getMyDataExport();
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = `loop-data-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke on the next tick so the click's navigation has read the
    // blob URL before we tear it down.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * `POST /api/users/me/dsr/delete` — request account deletion
 * (anonymisation per ADR-009; the credit ledger is append-only). On
 * success the caller's session is dead server-side, so the next authed
 * request 401s — callers should clear local session + redirect.
 *
 * Throws `ApiException` with a typed 409 `code` when deletion is
 * blocked by money/fulfilment in flight (`PENDING_PAYOUTS`,
 * `IN_FLIGHT_ORDERS`, `FAILED_UNCOMPENSATED_WITHDRAWALS`) so the UI can
 * render the matching instruction.
 */
export async function requestAccountDeletion(): Promise<{ ok: boolean }> {
  return authenticatedRequest<{ ok: boolean }>('/api/users/me/dsr/delete', {
    method: 'POST',
  });
}
