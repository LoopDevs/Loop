/**
 * Per-(asset_code, network) hot float bookkeeping (ADR 031 §Liquidity
 * safeguard, V4). Pure ledger arithmetic over `vault_hot_float`
 * (migration 0062) — never touches Soroban directly except in
 * `runHotFloatReplenishTick`'s single `withdrawFromVault` call.
 *
 * ── What the float is (and isn't) ──────────────────────────────────
 * `balance_minor` is the operator's canonical-asset (USDC/EURC)
 * working balance, denominated in the vault currency's FIAT minor
 * units — the SAME convention `vault_redemptions.value_minor` and
 * `vault_emissions.cashback_minor` use, so a redemption payout draws
 * directly without a share-price conversion at draw time. It is
 * OPERATOR working capital, never user liability — INV-V3 (ADR 031
 * §D4, "fee ≠ backing") extends naturally here: the float balance is
 * never counted as backing anyone's mirror balance, and drawing from
 * it never touches `user_credits`.
 *
 * `pending_unredeemed_shares` tracks vault shares the operator holds
 * from FAST-path redemption collects (`credits/vaults/
 * vault-redemptions.ts`'s payout step draws the float instead of
 * calling `vault.withdraw` synchronously) — real backing the operator
 * hasn't yet converted back to the canonical asset.
 * `runHotFloatReplenishTick` drains this via a batched
 * `vault.withdraw` and credits the proceeds back into `balance_minor`.
 *
 * ── Concurrency ─────────────────────────────────────────────────────
 * The tx-scoped primitives (`ensureFloatRowInTx` / `drawHotFloatInTx` /
 * `applyHotFloatDeltaInTx`) take a caller-owned transaction so a caller
 * that ALSO needs to write another table (`credits/vaults/
 * vault-redemptions.ts`'s payout step, which must atomically move the
 * float AND transition its own row) gets true cross-table atomicity —
 * both writes commit together or neither does. `tryDrawHotFloat` /
 * `creditHotFloat` are convenience wrappers that open their OWN
 * transaction for simpler, single-table callers (`runHotFloatReplenishTick`
 * below). `drawHotFloatInTx`'s `FOR UPDATE` makes concurrent draws
 * against the same balance safe. `runHotFloatReplenishTick` is NOT
 * internally single-flighted — it relies on its caller
 * (`vault-redemptions.ts`'s sweep, which already runs inside a
 * fleet-wide advisory lock) to serialize invocations. Two concurrent
 * replenish ticks racing the SAME pending shares would, at worst, have
 * the second `vault.withdraw` fail on-chain with insufficient share
 * balance (DeFindex cannot burn shares the operator doesn't hold) — a
 * retryable failure, not a double-spend — but this is a
 * defence-in-depth backstop, not the intended operating mode.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { vaultHotFloat, type LoopVaultAssetCode, type LoopVaultNetwork } from '../db/schema.js';
import { logger } from '../logger.js';
import { readVaultState, withdrawFromVault } from '../credits/vaults/vault-client.js';
import type { LoopVaultRow } from '../credits/vaults/registry.js';

const log = logger.child({ area: 'hot-float' });

export type HotFloatRow = typeof vaultHotFloat.$inferSelect;

/** Same 7-decimal LOOP-asset/underlying-asset stroop convention every vault module uses (`credits/vaults/vault-emissions.ts`). */
const STROOPS_PER_MINOR = 100_000n;

/** Slippage tolerance on the replenish withdraw's `minAmountsOut` floor, basis points below the expected value. */
const REPLENISH_SLIPPAGE_TOLERANCE_BPS = 50n; // 0.5%

/** Transaction type accepted by every `*InTx` helper — the same pattern `credits/vaults/vault-emissions.ts` uses for a helper that must run INSIDE a caller-owned transaction. */
export type HotFloatTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function ensureFloatRowInTx(
  tx: HotFloatTx,
  assetCode: LoopVaultAssetCode,
  network: LoopVaultNetwork,
): Promise<void> {
  await tx
    .insert(vaultHotFloat)
    .values({ assetCode, network, balanceMinor: 0n, pendingUnredeemedShares: 0n })
    .onConflictDoNothing({ target: [vaultHotFloat.assetCode, vaultHotFloat.network] });
}

/** Reads the float row (creating a zero row on first read for `(assetCode, network)`). No lock — callers needing a consistent read-then-write use `drawHotFloatInTx`/`tryDrawHotFloat` instead. */
export async function getHotFloatRow(
  assetCode: LoopVaultAssetCode,
  network: LoopVaultNetwork,
): Promise<HotFloatRow> {
  return db.transaction(async (tx) => {
    await ensureFloatRowInTx(tx, assetCode, network);
    const [row] = await tx
      .select()
      .from(vaultHotFloat)
      .where(and(eq(vaultHotFloat.assetCode, assetCode), eq(vaultHotFloat.network, network)));
    if (row === undefined) {
      throw new Error(
        `vault_hot_float row missing after ensureFloatRowInTx (${assetCode}/${network})`,
      );
    }
    return row;
  });
}

/**
 * The FAST path's draw (ADR 031 §D6 step 3), tx-scoped. Locks the row
 * `FOR UPDATE` and, only if the current balance covers `amountMinor`,
 * applies `balanceMinor -= amountMinor` and `pendingUnredeemedShares +=
 * pendingSharesDelta` in the SAME update — returns `false` (no write
 * at all) when the balance doesn't cover it. Callers wrap this in their
 * OWN transaction alongside whatever else must land atomically with the
 * draw (e.g. a `vault_redemptions` state transition) — see
 * `vault-redemptions.ts`'s payout step.
 */
export async function drawHotFloatInTx(
  tx: HotFloatTx,
  assetCode: LoopVaultAssetCode,
  network: LoopVaultNetwork,
  amountMinor: bigint,
  pendingSharesDelta: bigint,
): Promise<boolean> {
  await ensureFloatRowInTx(tx, assetCode, network);
  const [row] = await tx
    .select()
    .from(vaultHotFloat)
    .where(and(eq(vaultHotFloat.assetCode, assetCode), eq(vaultHotFloat.network, network)))
    .for('update');
  if (row === undefined || row.balanceMinor < amountMinor) {
    return false;
  }
  await tx
    .update(vaultHotFloat)
    .set({
      balanceMinor: sql`${vaultHotFloat.balanceMinor} - ${amountMinor}`,
      pendingUnredeemedShares: sql`${vaultHotFloat.pendingUnredeemedShares} + ${pendingSharesDelta}`,
      updatedAt: sql`NOW()`,
    })
    .where(and(eq(vaultHotFloat.assetCode, assetCode), eq(vaultHotFloat.network, network)));
  return true;
}

/** Standalone (own-transaction) convenience wrapper around `drawHotFloatInTx` for single-table callers. */
export async function tryDrawHotFloat(
  assetCode: LoopVaultAssetCode,
  network: LoopVaultNetwork,
  amountMinor: bigint,
): Promise<boolean> {
  return db.transaction((tx) => drawHotFloatInTx(tx, assetCode, network, amountMinor, 0n));
}

/**
 * Applies a net `(balanceDelta, pendingSharesDelta)` to the float row,
 * tx-scoped — a pure delta UPDATE, safe under concurrency, no read
 * needed (unlike the draw, a credit never needs to check sufficiency).
 * Used by the SLOW path (`vault-redemptions.ts`'s payout step credits
 * the vault-withdraw proceeds net of the amount it settles, atomically
 * with its own state transition) and by `runHotFloatReplenishTick`.
 */
export async function applyHotFloatDeltaInTx(
  tx: HotFloatTx,
  assetCode: LoopVaultAssetCode,
  network: LoopVaultNetwork,
  balanceDelta: bigint,
  pendingSharesDelta: bigint,
): Promise<void> {
  await ensureFloatRowInTx(tx, assetCode, network);
  await tx
    .update(vaultHotFloat)
    .set({
      balanceMinor: sql`${vaultHotFloat.balanceMinor} + ${balanceDelta}`,
      pendingUnredeemedShares: sql`${vaultHotFloat.pendingUnredeemedShares} + ${pendingSharesDelta}`,
      updatedAt: sql`NOW()`,
    })
    .where(and(eq(vaultHotFloat.assetCode, assetCode), eq(vaultHotFloat.network, network)));
}

/** Standalone (own-transaction) convenience wrapper for a pure credit. */
export async function creditHotFloat(
  assetCode: LoopVaultAssetCode,
  network: LoopVaultNetwork,
  amountMinor: bigint,
): Promise<void> {
  await db.transaction((tx) => applyHotFloatDeltaInTx(tx, assetCode, network, amountMinor, 0n));
}

export interface HotFloatReplenishResult {
  replenished: boolean;
  amountMinor?: bigint;
  txHash?: string;
}

/**
 * Batched replenishment (ADR 031 §D6 step 3's "async" half). If the
 * vault has any `pending_unredeemed_shares`, redeems the WHOLE pending
 * balance in one `vault.withdraw` call and credits the proceeds back
 * into `balance_minor`. No-ops (does not touch the chain) when there
 * is nothing pending. See the module header for the concurrency
 * contract — callers must serialize invocations per (assetCode,
 * network) themselves (the redemption sweep's fleet-wide lock does
 * this).
 */
export async function runHotFloatReplenishTick(
  vault: LoopVaultRow,
): Promise<HotFloatReplenishResult> {
  const row = await getHotFloatRow(
    vault.assetCode as LoopVaultAssetCode,
    vault.network as LoopVaultNetwork,
  );
  if (row.pendingUnredeemedShares <= 0n) {
    return { replenished: false };
  }
  const shares = row.pendingUnredeemedShares;

  const state = await readVaultState({ vault });
  const expectedUnderlying = (shares * state.sharePricePpm) / 1_000_000n;
  const minAmountsOut =
    expectedUnderlying - (expectedUnderlying * REPLENISH_SLIPPAGE_TOLERANCE_BPS) / 10_000n;
  if (minAmountsOut <= 0n) {
    log.warn(
      { assetCode: vault.assetCode, network: vault.network, shares },
      'hot-float replenish: computed non-positive minAmountsOut — skipping this tick',
    );
    return { replenished: false };
  }

  // KNOWN GAP (accepted for V4): unlike `vault_redemptions`/
  // `vault_emissions`, there is no durable row to persist this
  // withdraw's CF-18 hash into — a crash between signing and this
  // function returning loses the hash, so a retry builds a FRESH
  // withdraw for the same pending shares rather than resuming the
  // prior one. Self-correcting, not silently wrong: DeFindex cannot
  // burn shares the operator no longer holds, so a genuine double-
  // attempt fails on-chain (a wasted tx + a retry), matching the
  // module header's documented residual-race posture. A durable
  // `hot_float_replenish_attempts` row (mirroring the redemption/
  // emission pattern) would close this — deferred as a V5 tightening.
  const result = await withdrawFromVault({
    vault,
    shares,
    minAmountsOut,
    onSigned: () => {},
  });
  const amountOutStroops = result.amountsOut[0];
  if (amountOutStroops === undefined) {
    throw new Error(
      `hot-float replenish: withdrawFromVault returned an empty amountsOut (${vault.assetCode}/${vault.network})`,
    );
  }
  const amountOutMinor = amountOutStroops / STROOPS_PER_MINOR;

  // Delta subtract on pendingUnredeemedShares (not "set to 0") — safe
  // if a concurrent fast-path draw added MORE pending shares after our
  // read above (module header's concurrency note).
  await db.transaction((tx) =>
    applyHotFloatDeltaInTx(
      tx,
      vault.assetCode as LoopVaultAssetCode,
      vault.network as LoopVaultNetwork,
      amountOutMinor,
      -shares,
    ),
  );

  log.info(
    {
      assetCode: vault.assetCode,
      network: vault.network,
      shares,
      amountOutMinor,
      txHash: result.txHash,
    },
    'hot-float replenished',
  );
  return { replenished: true, amountMinor: amountOutMinor, txHash: result.txHash };
}
