/**
 * `recordVaultOperatorMovement` — the vault-aware-R3-1 half of ADR
 * 031 §Detailed design D4 (V5). Deliberately its OWN leaf module
 * (not part of `hot-float-reconciliation.ts`, which defines the
 * float/pool-desync check and depends on `hot-float.ts` for
 * `getHotFloatRow`) so `hot-float.ts` can import THIS without
 * creating a `hot-float.ts` ↔ `hot-float-reconciliation.ts` import
 * cycle — `vault-emissions.ts`, `vault-redemptions.ts`, and
 * `hot-float.ts` all call this at the moment they move the
 * operator's USDC balance via a vault call; none of them need
 * anything from `hot-float-reconciliation.ts` itself.
 *
 * See `hot-float-reconciliation.ts`'s module header for the FULL
 * rationale (why R3-1 is structurally blind to Soroban vault calls,
 * why an unlinked `operator_manual_movements` row is the fix, and the
 * USDC-only / EURC-not-yet-covered scope note) — this file is just
 * the write primitive three other modules share.
 */
import { db } from '../db/client.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { operatorManualMovements } from '../db/schema.js';
import type { LoopVaultRow } from '../credits/vaults/registry.js';

const log = logger.child({ area: 'vault-operator-movement' });

export interface RecordVaultOperatorMovementArgs {
  vault: LoopVaultRow;
  direction: 'in' | 'out';
  /** Stroops (7-decimal), same convention as `operator_wallet_movements.amount_stroops`. */
  amountStroops: bigint;
  reason: string;
}

/**
 * Best-effort. Never throws — a failure here must never block or fail
 * the caller's real on-chain money movement; it only means R3-1 shows
 * drift until an operator manually explains the row (the exact
 * pre-V5 posture, just for one row instead of every vault call).
 *
 * CALLER CONTRACT (money-review V5 P2-2): every call site invokes this
 * AFTER its own money-moving state transition has committed, and does
 * NOT wrap it in its own try/catch — both rely on this function never
 * throwing. The two properties together are what make "record once,
 * possibly miss on a crash, never double-count" hold and what keep a
 * (hypothetical future) throw from ever being mis-attributed to the
 * caller's money step. If you add a new call site, preserve BOTH: call
 * post-commit, and keep this catch-all in place. The internal
 * try/catch below is the load-bearing half of that contract.
 */
export async function recordVaultOperatorMovement(
  args: RecordVaultOperatorMovementArgs,
): Promise<void> {
  if (args.amountStroops <= 0n) return;
  if (args.vault.underlyingAssetCode !== 'USDC') {
    log.debug(
      { assetCode: args.vault.assetCode, underlying: args.vault.underlyingAssetCode },
      'recordVaultOperatorMovement: non-USDC-backed vault — R3-1 has no tracked asset for this underlying yet (V5 scope), skipping',
    );
    return;
  }
  const account = env.LOOP_STELLAR_DEPOSIT_ADDRESS;
  if (account === undefined) return; // R3-1 itself isn't configured — nothing to explain against
  if (
    env.LOOP_STELLAR_USDC_ISSUER === undefined ||
    args.vault.underlyingAssetIssuer !== env.LOOP_STELLAR_USDC_ISSUER
  ) {
    log.warn(
      {
        assetCode: args.vault.assetCode,
        vaultUnderlyingIssuer: args.vault.underlyingAssetIssuer,
        configuredUsdcIssuer: env.LOOP_STELLAR_USDC_ISSUER ?? null,
      },
      "recordVaultOperatorMovement: the vault's underlying USDC issuer does not match LOOP_STELLAR_USDC_ISSUER — refusing to record an R3-1 movement note for a different asset identity than R3-1 tracks",
    );
    return;
  }
  try {
    await db.insert(operatorManualMovements).values({
      asset: 'usdc',
      account,
      direction: args.direction,
      amountStroops: args.amountStroops,
      movementPaymentId: null,
      reason: args.reason.slice(0, 500),
      createdBy: `system:vault-${args.vault.assetCode.toLowerCase()}`,
    });
  } catch (err) {
    log.error(
      { err, assetCode: args.vault.assetCode, direction: args.direction },
      'Failed to record vault operator movement for R3-1 — float reconciliation may show false drift until this is manually explained via the admin endpoint',
    );
  }
}
