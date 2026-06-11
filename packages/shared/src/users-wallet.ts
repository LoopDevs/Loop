/**
 * `GET /api/me/wallet` + `POST /api/orders/loop/:id/pay-with-balance`
 * wire shapes (ADR 030 Phase C).
 *
 * The embedded-wallet balance surface: on-chain LOOP balances are
 * the user's authoritative balance under ADR 036, so the wallet
 * card reads this endpoint (never the off-chain mirror). Lives in
 * `@loop/shared` per ADR 019 — backend emits it, web consumes it,
 * and the shared-type-parity gate holds both sides to one
 * definition.
 */
import type { LoopAssetCode } from './loop-asset.js';

/**
 * Wallet-provisioning lifecycle (`users.wallet_provisioning`,
 * migration 0040):
 *
 *   - `none`           — no provider wallet yet
 *   - `wallet_created` — provider wallet exists, Stellar account not
 *                        yet activated (no trustlines — payouts wait)
 *   - `activated`      — operator-sponsored account live with
 *                        trustlines to every configured LOOP asset
 */
export type WalletProvisioningState = 'none' | 'wallet_created' | 'activated';

/** One on-chain LOOP-asset balance on the user's embedded wallet. */
export interface UserWalletBalance {
  assetCode: LoopAssetCode;
  /**
   * Horizon-style 7-decimal amount string (e.g. `"5.0000000"` for
   * 5 GBPLOOP). String to survive JSON round-trips losslessly.
   */
  balance: string;
}

/** `GET /api/me/wallet` */
export interface UserWalletResponse {
  /** Embedded-wallet Stellar address. Null until a wallet is provisioned. */
  address: string | null;
  provisioning: WalletProvisioningState;
  /**
   * On-chain LOOP-asset balances (authoritative per ADR 036). Empty
   * until the wallet is activated; only configured LOOP assets are
   * listed.
   */
  balances: UserWalletBalance[];
  /** Interest APY in basis points (`0` = interest off). */
  interestApyBps: number;
  /**
   * True when Horizon was unreachable and the balances are a
   * last-known-good snapshot (or empty when none was cached). The
   * never-500 fallback per ADR 020 discipline.
   */
  stale: boolean;
}

/**
 * `POST /api/orders/loop/:id/pay-with-balance` 200 response.
 * `state` is the order's state after the balance payment was
 * submitted; clients keep polling `GET /api/orders/loop/:id` exactly
 * as they do for the crypto deposit path — the deposit watcher remains
 * the authoritative state machine.
 *
 * Error contract: 400 `{ code: 'INSUFFICIENT_BALANCE' }` when the
 * up-front Horizon read says the matching LOOP-asset balance doesn't
 * cover the charge; 503 when the wallet provider / Horizon is
 * unavailable.
 */
export interface PayWithBalanceResponse {
  state: string;
}
