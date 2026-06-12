/**
 * `/api/admin/users/:userId/wallet*` wire shapes (ADR 037 — User 360
 * wallet card; ADR 030 Phase C provisioning).
 *
 * Admin view over a user's embedded-wallet provisioning state. The
 * user-facing sibling is `UserWalletResponse` (`users-wallet.ts`);
 * this one adds the provider/walletId/attempt telemetry support needs
 * to unstick a stuck provisioning run, and omits the user-surface
 * extras (APY, staleness flag).
 */
import type { UserWalletBalance, WalletProvisioningState } from './users-wallet.js';

/** `GET /api/admin/users/:userId/wallet` */
export interface AdminUserWalletView {
  /** Embedded-wallet provider tag (e.g. `'privy'`). Null when no wallet. */
  provider: string | null;
  /** Provider-side wallet id. Null when no wallet. */
  walletId: string | null;
  /** Stellar address. Null until provisioned. */
  address: string | null;
  provisioning: WalletProvisioningState;
  /** On-chain LOOP balances — empty until activated. */
  balances: UserWalletBalance[];
  /** Provisioning attempts so far (0 when never attempted). */
  attempts: number;
  lastAttemptAt: string | null;
}

/**
 * `POST /api/admin/users/:userId/wallet/reprovision` — re-enqueues the
 * provisioning sweep for this user. Support-allowed (ADR 037 §3:
 * idempotent re-drive, no money movement).
 */
export interface AdminWalletReprovisionResult {
  enqueued: boolean;
}
