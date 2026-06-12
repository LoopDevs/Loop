/**
 * Embedded-wallet API (ADR 030 Phase C).
 *
 * Thin wrappers over `GET /api/me/wallet` (balance surface) and
 * `POST /api/orders/loop/:id/redeem` (one-tap redemption). Wire
 * shapes live in `@loop/shared/me-wallet.ts` (ADR 019); this module
 * holds fetchers, local re-exports, and the pure cover-math helpers
 * the checkout button needs.
 *
 * The on-chain LOOP-asset balance is the user's authoritative balance
 * — the off-chain mirror is never user-visible. Balances arrive as
 * Horizon decimal strings (7 fractional digits), while order charges
 * are minor units (2 fractional digits); `loopBalanceCoversCharge`
 * normalises both to stroops before comparing so no float precision
 * is involved.
 */
import type {
  RedeemLoopOrderResponse,
  UserWalletBalance,
  UserWalletResponse,
  WalletProvisioningState,
} from '@loop/shared';
import { authenticatedRequest } from './api-client';

// Historical web-side names for the `GET /api/me/wallet` contract —
// the canonical shapes live in `@loop/shared/users-wallet.ts`
// (`UserWalletResponse` adds the `stale` last-known-good flag the
// backend emits; this surface tolerates it).
export type MeWalletBalance = UserWalletBalance;
export type MeWalletResponse = UserWalletResponse;
export type { RedeemLoopOrderResponse, WalletProvisioningState };

/**
 * `GET /api/me/wallet` — the caller's embedded-wallet surface:
 * address, provisioning state, on-chain balances, interest APY.
 */
export async function getMyWallet(): Promise<MeWalletResponse> {
  return authenticatedRequest<MeWalletResponse>('/api/me/wallet');
}

/**
 * `POST /api/orders/loop/:id/redeem` — one-tap payment of a
 * `pending_payment` Loop-native order from the user's on-chain LOOP
 * balance. Idempotent on order id server-side, so a double-tap can't
 * double-spend. The response carries the order's post-submit `state`;
 * callers keep polling `GET /api/orders/loop/:id` exactly as the
 * crypto-deposit path does — the watcher stays authoritative.
 *
 * Errors surface as `ApiException`: 400 `INSUFFICIENT_BALANCE` when
 * the balance doesn't cover the charge, 503 when the wallet provider
 * or Horizon is unavailable.
 */
export async function redeemLoopOrder(orderId: string): Promise<RedeemLoopOrderResponse> {
  return authenticatedRequest<RedeemLoopOrderResponse>(
    `/api/orders/loop/${encodeURIComponent(orderId)}/redeem`,
    { method: 'POST' },
  );
}

/**
 * Horizon balance string (`"42.5000000"`, ≤7 fractional digits) →
 * stroops bigint. Returns null on malformed input so callers degrade
 * to "don't offer the button" rather than throwing mid-render.
 */
export function balanceToStroops(balance: string): bigint | null {
  const m = /^(-?)(\d+)(?:\.(\d{1,7}))?$/.exec(balance.trim());
  if (m === null) return null;
  const [, sign, whole, frac = ''] = m;
  try {
    const stroops = BigInt(whole!) * 10_000_000n + BigInt(frac.padEnd(7, '0'));
    return sign === '-' ? -stroops : stroops;
  } catch {
    return null;
  }
}

/**
 * Minor units (2 fractional digits, bigint-as-string or number) →
 * stroops bigint. `1250` minor → `125_000_000n` stroops.
 */
export function minorToStroops(amountMinor: string | number): bigint | null {
  try {
    const minor = typeof amountMinor === 'number' ? BigInt(amountMinor) : BigInt(amountMinor);
    return minor * 100_000n;
  } catch {
    return null;
  }
}

/**
 * Does a Horizon balance cover an order charge? Both sides normalise
 * to stroops; malformed input is "no" (the server re-checks anyway —
 * this only decides whether to OFFER the one-tap button).
 */
export function loopBalanceCoversCharge(balance: string, chargeMinor: string | number): boolean {
  const have = balanceToStroops(balance);
  const need = minorToStroops(chargeMinor);
  if (have === null || need === null) return false;
  return have >= need;
}
