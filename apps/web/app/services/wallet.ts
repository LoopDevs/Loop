/**
 * Embedded-wallet API (ADR 030 Phase C).
 *
 * Thin wrappers over `GET /api/me/wallet` (balance surface). Wire
 * shapes live in `@loop/shared/users-wallet.ts` — ADR 019, shared
 * with the backend's handlers, one definition each; this module holds
 * fetchers, local re-exports, and the pure balance-math helpers.
 *
 * The on-chain LOOP-asset balance is the user's authoritative balance
 * — the off-chain mirror is never user-visible. Balances arrive as
 * Horizon decimal strings (7 fractional digits), while order charges
 * are minor units (2 fractional digits); `loopBalanceCoversCharge`
 * normalises both to stroops before comparing so no float precision
 * is involved.
 */
import type { UserWalletBalance, UserWalletResponse, WalletProvisioningState } from '@loop/shared';
import { authenticatedRequest } from './api-client';

export type { UserWalletBalance, UserWalletResponse, WalletProvisioningState };

/**
 * `GET /api/me/wallet` — the caller's embedded-wallet surface:
 * address, provisioning state, on-chain balances, interest APY.
 */
export async function getMyWallet(): Promise<UserWalletResponse> {
  return authenticatedRequest<UserWalletResponse>('/api/me/wallet');
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
