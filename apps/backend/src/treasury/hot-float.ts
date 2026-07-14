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
import { recordVaultOperatorMovement } from './vault-operator-movement.js';

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
 *
 * `carryStroopsDelta` (MNY-06-REDEMPTION-DUST) folds a NON-NEGATIVE
 * sub-minor stroop remainder into `carry_stroops`, flushing a whole
 * minor into `balance_minor` the moment carry crosses STROOPS_PER_MINOR
 * — the SAME `(carry + stroops) / PER` flush / `(carry + stroops) % PER`
 * retain idiom `runHotFloatReplenishTick` carries inline for the
 * replenish path (MNY-06-hotfloat). A caller whose credit lands on a
 * whole-minor boundary passes the default `0n` and gets the original
 * plain-delta behaviour (`(carry + 0) / PER == 0`, `(carry + 0) % PER ==
 * carry`), so this is a strict superset — pre-existing callers are
 * byte-for-byte unchanged. Because `carryStroopsDelta` is required
 * non-negative and the stored carry is already in `[0, PER)`, the sum
 * stays in `[0, 2*PER)` and the retained `% PER` never leaves
 * `[0, PER)` — the `vault_hot_float_carry_bounded` CHECK holds
 * regardless of the SIGN of `balanceDelta` (the signed whole-minor part
 * lands only in `balance_minor`, never in the carry).
 */
export async function applyHotFloatDeltaInTx(
  tx: HotFloatTx,
  assetCode: LoopVaultAssetCode,
  network: LoopVaultNetwork,
  balanceDelta: bigint,
  pendingSharesDelta: bigint,
  carryStroopsDelta: bigint = 0n,
): Promise<void> {
  await ensureFloatRowInTx(tx, assetCode, network);
  await tx
    .update(vaultHotFloat)
    .set({
      balanceMinor: sql`${vaultHotFloat.balanceMinor} + ${balanceDelta} + (${vaultHotFloat.carryStroops} + ${carryStroopsDelta}) / ${STROOPS_PER_MINOR}`,
      carryStroops: sql`(${vaultHotFloat.carryStroops} + ${carryStroopsDelta}) % ${STROOPS_PER_MINOR}`,
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

  // KNOWN GAP (accepted for V4, money-review): unlike `vault_redemptions`/
  // `vault_emissions`, there is no durable row to persist this
  // withdraw's CF-18 hash into — a crash between signing and this
  // function returning loses the hash, so a retry builds a FRESH
  // withdraw for the same pending shares. This is NOT self-correcting:
  // if a genuine double-attempt (retry, or two concurrent replenish
  // ticks) both LAND — the operator may hold enough shares from other
  // rows for the second not to fail on-chain — the vault burns MORE
  // shares than one tick's proceeds crediting back the float, leaving
  // UNTRACKED float/pool drift. It fails CLOSED to that drift (never a
  // double-credit of the float — each landed withdraw's proceeds are
  // credited by AT MOST the tick that observed them), and the
  // vault-aware R3-1 operator-float reconciliation must catch and
  // reconcile it (a prerequisite before `LOOP_VAULTS_ENABLED` is
  // flipped on). A durable `hot_float_replenish_attempts` row
  // (mirroring the redemption/emission CF-18 pattern) would close the
  // gap — deferred as a V5 tightening.
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

  // MNY-06-hotfloat: the withdraw proceeds (`amountOutStroops`, 7-decimal
  // underlying stroops) DO NOT generally land on a whole-minor boundary,
  // so a plain `amountOutStroops / STROOPS_PER_MINOR` would TRUNCATE the
  // `amountOutStroops % STROOPS_PER_MINOR` sub-minor remainder — real
  // on-chain USDC dropped from the float on every tick, accumulating over
  // time into a growing, unaccounted gap (the leak this fix removes).
  // Instead we carry the remainder forward in `carry_stroops` and flush a
  // whole minor into `balance_minor` only once carry + this tick's
  // remainder crosses STROOPS_PER_MINOR — conserving every stroop:
  // `balance_minor * PER + carry_stroops == Σ amountOutStroops`. Same
  // carry idiom as `credits/interest-mint.ts` `splitPayable`.
  //
  // `creditedMinor` is the whole-minor amount this tick flushes to the
  // balance, reported to the log / caller. It is derived from the
  // `carry_stroops` this tick READ (`row`, from the unlocked
  // `getHotFloatRow`) — telemetry only, in the same best-effort spirit as
  // `shares` above; the AUTHORITATIVE credit is the pure-SQL
  // read-modify-write below, which reads the row's CURRENT carry.
  const creditedMinor = (row.carryStroops + amountOutStroops) / STROOPS_PER_MINOR;

  // Credit the withdraw proceeds and retire the pending shares this
  // tick redeemed. Two properties matter here:
  //
  //   1. Delta subtract on pendingUnredeemedShares (not "set to 0") —
  //      safe if a concurrent fast-path draw ADDED more pending shares
  //      after our read above (module header's concurrency note); we
  //      retire only the `shares` this tick captured, leaving the rest.
  //   2. The subtract is CLAMPED at zero (`GREATEST(… , 0)`), not a
  //      blind `- shares`. `shares` came from an UNLOCKED read
  //      (`getHotFloatRow`) and the on-chain `withdraw` — a network
  //      round-trip we cannot hold a row lock across — commits before
  //      we reach here. So a second replenish tick that raced the SAME
  //      `pending_unredeemed_shares` (module header + hot-float-
  //      reconciliation.ts §(b)) can have already retired them: a blind
  //      `pending - shares` would then underflow and trip the
  //      `vault_hot_float_pending_shares_non_negative` CHECK, ABORTING
  //      this transaction — which would silently drop THIS tick's real,
  //      already-landed proceeds credit AND skip the R3-1 movement
  //      record below (the OPPOSITE of the stated intent). Clamping
  //      keeps the invariant `pending >= 0` while still crediting every
  //      landed withdraw; the residual share-level drift (more shares
  //      burned than one row's pending accounted for) is exactly what
  //      the R3-1 reconciler exists to surface — and can only surface
  //      once this credit + its movement below actually commit.
  await db.transaction(async (tx) => {
    await ensureFloatRowInTx(
      tx,
      vault.assetCode as LoopVaultAssetCode,
      vault.network as LoopVaultNetwork,
    );
    await tx
      .update(vaultHotFloat)
      .set({
        // Flush whole minors, carry the sub-minor remainder. Both
        // expressions read the row's CURRENT `carry_stroops`, so under
        // READ COMMITTED a concurrent tick's committed carry is folded in
        // (Postgres re-evaluates SET against the updated row) — carry
        // accumulates correctly without a separate FOR UPDATE, matching
        // the atomic-per-row-UPDATE idiom the balance delta and the
        // GREATEST pending clamp already rely on. `carry_stroops` stays a
        // proper sub-minor remainder (0 <= carry < PER, DB-CHECKed).
        balanceMinor: sql`${vaultHotFloat.balanceMinor} + (${vaultHotFloat.carryStroops} + ${amountOutStroops}) / ${STROOPS_PER_MINOR}`,
        carryStroops: sql`(${vaultHotFloat.carryStroops} + ${amountOutStroops}) % ${STROOPS_PER_MINOR}`,
        pendingUnredeemedShares: sql`GREATEST(${vaultHotFloat.pendingUnredeemedShares} - ${shares}, 0)`,
        updatedAt: sql`NOW()`,
      })
      .where(
        and(
          eq(vaultHotFloat.assetCode, vault.assetCode as LoopVaultAssetCode),
          eq(vaultHotFloat.network, vault.network as LoopVaultNetwork),
        ),
      );
  });

  log.info(
    {
      assetCode: vault.assetCode,
      network: vault.network,
      shares,
      creditedMinor,
      amountOutStroops,
      txHash: result.txHash,
    },
    'hot-float replenished',
  );

  // V5 (ADR 031 §D4): explain this USDC-denominated inflow to R3-1
  // (`treasury/hot-float-reconciliation.ts`) — best-effort, placed
  // after the float credit commits. UNLIKE the emission depositStep
  // and redemption slow-path call sites (both fenced by a state-CAS
  // claim, so they genuinely record-once), THIS site has no per-call
  // idempotency fence — it inherits the module's own documented KNOWN
  // GAP above (no CF-18 hash persisted for the replenish withdraw). So
  // in the accepted double-withdraw residual, two landed withdraws each
  // reach their own `recordVaultOperatorMovement` and BOTH movements
  // are recorded. That is the CORRECT outcome here: each real on-chain
  // USDC inflow is a distinct movement R3-1 must account for, and each
  // is credited to the float by at most the tick that observed it —
  // suppressing the second note would hide the very drift R3-1 exists
  // to surface. It is a genuine double-record, not the "record-once"
  // guarantee the other two sites have; called out so a future reader
  // doesn't assume parity.
  await recordVaultOperatorMovement({
    vault,
    direction: 'in',
    amountStroops: amountOutStroops,
    reason: `Hot-float replenish withdraw (${vault.assetCode}/${vault.network}, ${shares} shares)`,
  });

  return { replenished: true, amountMinor: creditedMinor, txHash: result.txHash };
}
