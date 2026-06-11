/**
 * Embedded-wallet wire shapes (ADR 030 Phase C).
 *
 * `GET /api/me/wallet` + `POST /api/orders/loop/:id/pay-with-balance`.
 * Both sides of the boundary need the exact same contract — web renders
 * the balance surface and the one-tap pay button, backend emits the
 * shapes — so they live here per ADR 019.
 *
 * The on-chain LOOP-asset balance returned here is the user's
 * authoritative balance (the off-chain mirror is never user-visible).
 * Balances are Horizon-style decimal strings (7 fractional digits),
 * NOT minor units — convert before comparing against `chargeMinor`.
 */

/**
 * Wallet provisioning lifecycle (wallet-integration-plan §C1).
 * `none → wallet_created → activated`, re-driven by the backend
 * sweeper. Signup never blocks on this — the user can browse and buy
 * while provisioning completes in the background; only payouts and
 * pay-with-balance need `activated`.
 */
export const WALLET_PROVISIONING_STATES = ['none', 'wallet_created', 'activated'] as const;
export type WalletProvisioningState = (typeof WALLET_PROVISIONING_STATES)[number];

/**
 * One on-chain balance row. `assetCode` is a plain string (not
 * `LoopAssetCode`) on purpose: the wire contract allows any asset the
 * wallet holds; clients narrow with `isLoopAssetCode()` when they only
 * care about LOOP-branded assets.
 */
export interface MeWalletBalance {
  assetCode: string;
  /** Horizon decimal string, 7 fractional digits (e.g. `"42.5000000"`). */
  balance: string;
}

/**
 * `GET /api/me/wallet` response. Never-500 with last-known-good on the
 * backend (ADR 020 discipline, but authed).
 *
 * `interestApyBps` is the nightly-interest APY in basis points
 * (`300` = 3%); `0` means no interest line should be rendered.
 */
export interface MeWalletResponse {
  /** Stellar address of the embedded wallet; null until provisioned. */
  address: string | null;
  provisioning: WalletProvisioningState;
  balances: MeWalletBalance[];
  interestApyBps: number;
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
