/**
 * Admin vault-emission / vault-redemption re-drive (ADR 031 V7 — the
 * recovery complement to the V5a stuck-watchdog page).
 *
 * `POST /api/admin/vault-emissions/:id/redrive` and
 * `POST /api/admin/vault-redemptions/:id/redrive` — the operator lever
 * for a `failed` (attempts-exhausted) or operator-confirmed-stuck
 * vault row. Both re-enter the row's EXISTING drive
 * (`driveOneVaultEmission` / `driveOneVaultRedemption`,
 * `apps/backend/src/credits/vaults/vault-{emissions,redemptions}.ts`)
 * from wherever its persisted on-chain markers prove it actually
 * landed — never re-doing a completed deposit/transfer/collect/payout
 * step, mirroring the same CF-18 verify-or-resubmit contract every
 * other resume in this codebase relies on.
 *
 * Admin-tier + step-up (ADR 028 `'vault-redrive'` scope) — like
 * order-redrive, this can submit a real outbound Soroban call.
 *
 * Lives in `@loop/shared` per ADR 019: the backend emits this shape,
 * an admin vault-recovery UI (if/when built) consumes it, and the
 * shared-type-parity gate holds both sides to one definition.
 */

/** Mirrors `VaultEmissionDriveOutcome` (backend-only type) — kept as an independent literal union here per ADR 019 (shared cannot import backend types). */
export type AdminVaultEmissionRedriveOutcome =
  | 'depositing'
  | 'deposited'
  | 'transferred'
  | 'mirrored'
  | 'failed'
  | 'no_vault'
  | 'claimed_elsewhere';

/** `result` half of `POST /api/admin/vault-emissions/:id/redrive`. */
export interface AdminVaultEmissionRedriveResult {
  vaultEmissionId: string;
  orderId: string;
  /** The row's `state` at the moment this redrive call was received (e.g. `'failed'`). */
  priorState: string;
  /**
   * The state `driveOneVaultEmission` was actually invoked from — for
   * a `failed` row this is the INFERRED resume state (never `'pending'`
   * unless the row was already `'pending'`), so a caller can confirm no
   * completed on-chain step was re-attempted (e.g. `priorState:
   * 'failed'`, `resumedFromState: 'transferred'` proves the deposit +
   * transfer were NOT redone — only the mirror step re-ran).
   */
  resumedFromState: string;
  /** What `driveOneVaultEmission` reported for this attempt. */
  outcome: AdminVaultEmissionRedriveOutcome;
  /** The row's state AFTER the re-drive attempt, re-read fresh from the DB. */
  state: string;
  attempts: number;
}

/** Mirrors `VaultRedemptionDriveOutcome` (backend-only type). */
export type AdminVaultRedemptionRedriveOutcome =
  | 'collecting'
  | 'redeemed'
  | 'settled'
  | 'failed'
  | 'no_vault'
  | 'claimed_elsewhere';

/** `result` half of `POST /api/admin/vault-redemptions/:id/redrive`. */
export interface AdminVaultRedemptionRedriveResult {
  vaultRedemptionId: string;
  sourceType: string;
  sourceId: string;
  priorState: string;
  /** The state `driveOneVaultRedemption` was actually invoked from — see the emission-side equivalent's doc comment. */
  resumedFromState: string;
  outcome: AdminVaultRedemptionRedriveOutcome;
  state: string;
  attempts: number;
}
