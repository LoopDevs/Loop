/**
 * LOOPUSD/LOOPEUR vault cashback-EMISSION flow (ADR 031 §Detailed
 * design D5, V3). Builds on the V1 registry (`registry.ts`) and the
 * V2 Soroban client (`vault-client.ts` — `depositToVault`,
 * `transferShares`, `readVaultState`) to implement the actual
 * cashback-emission state machine `vault-client.ts`'s header marks as
 * a `TODO(V3)`: a durable idempotency layer keyed on the source
 * cashback event id, claimed BEFORE any on-chain action.
 *
 * ── The gated fork (`orders/fulfillment.ts`) ───────────────────────
 * Cashback for a fulfilled order goes down ONE of two mutually
 * exclusive paths, decided once, at fulfillment time:
 *   - classic: `pending_payouts kind='order_cashback'` (unchanged,
 *     the byte-identical default when `LOOP_VAULTS_ENABLED=false`).
 *   - vault: this module. `orders/fulfillment.ts` inserts a
 *     `vault_emissions` CLAIM row (via `claimVaultEmission`, fast,
 *     local, no network I/O) in the SAME transaction as the order's
 *     `fulfilled` transition — atomic with the state change, same as
 *     the classic path's `pending_payouts` insert.
 * The claim is where fulfillment's involvement ENDS. Soroban I/O
 * (deposit + transfer, each with polling) cannot run inside that
 * short DB transaction — it would hold the order/user_credits row
 * locks across unbounded network latency. Instead, `startVaultEmissionSweep`
 * (interval-based, same shape as `credits/interest-mint.ts`) drains
 * `pending` / `deposited` / `transferred` rows on its own cadence —
 * exactly how the classic `pending_payouts` queue is drained by the
 * separate `payout-submit.ts` worker rather than inline at
 * fulfillment time.
 *
 * ── State machine (§D5) ─────────────────────────────────────────────
 *   pending → depositing → deposited → transferred → mirrored  (+ failed)
 *
 *   1. pending      claimed (`claimVaultEmission`), nothing on-chain yet.
 *   1b. depositing  a sweep CLAIMED this row for its deposit via an
 *                   atomic `pending → depositing` state-CAS
 *                   (`claimEmissionForDeposit`), committed BEFORE the
 *                   deposit's network call — the cross-machine
 *                   double-deposit guard (see below).
 *   2. deposited    `vault.deposit([X], [minShares], operator, true)`
 *                   landed → operator holds `sharesMinted` LOOPUSD/
 *                   LOOPEUR shares. `depositTxHash` persisted via
 *                   CF-18 `onSigned` BEFORE submit.
 *   3. transferred  `share.transfer(operator → user, sharesMinted)`
 *                   landed. INV-V1 (no unbacked shares): the transfer
 *                   amount is ALWAYS `row.sharesMinted` — the exact
 *                   count this row's own deposit minted, never a
 *                   value from another row or a caller-supplied
 *                   amount — so "shares transferred == shares minted"
 *                   holds by construction, not by a runtime check.
 *   4. mirrored     the off-chain `user_credits` liability is
 *                   credited (`credit_transactions` + `user_credits`,
 *                   the SAME lock-then-write discipline every other
 *                   `credits/` primitive uses — INV-2) AND a
 *                   `pending_payouts kind='emission'` AUDIT row is
 *                   written in the SAME transaction so the
 *                   pre-existing `assert_emission_conservation`
 *                   trigger (migration 0044, widened by migration
 *                   0061 to know LOOPUSD/LOOPEUR) checks this mint
 *                   against the mirror too — never a bespoke
 *                   `user_credits` UPDATE (ADR 047 §3's rule, applied
 *                   here). That audit row is written ALREADY
 *                   `state='confirmed'` with the transfer's real
 *                   `txHash` — it is NOT a queued intent, so the
 *                   classic payout-submit worker (which only reads
 *                   `state='pending'` rows) never touches it. A
 *                   share-price snapshot follows, best-effort (never
 *                   blocks advancing to `mirrored` — the emission
 *                   already landed and the mirror already committed).
 *   failed          terminal after `VAULT_EMISSION_MAX_ATTEMPTS`
 *                   consecutive step failures. NOT auto-retried by
 *                   the sweep — needs an operator look. KNOWN GAP: no
 *                   admin re-drive endpoint ships in V3 (see
 *                   `docs/adr/031-per-currency-yield-architecture.md`
 *                   — a follow-up, mirroring the admin payout-retry
 *                   endpoint's shape).
 *
 * Every step's on-chain call threads CF-18 (`priorTxHash` /
 * `onSigned`, `vault-client.ts`) so a crash between "tx signed" and
 * "row updated" resumes via the persisted hash rather than
 * re-submitting. Resuming from `depositing`, `deposited`, or
 * `transferred` does NOT re-run any earlier step — the state machine
 * only ever advances forward from `row.state`.
 *
 * ── Cross-machine double-deposit guard (money-review #1647 P1) ──────
 * The sweep's fleet-wide `withAdvisoryLock` DEGRADES to un-serialized
 * when `DATABASE_URL` is a transaction pooler (`db/client.ts`). If it
 * degrades, two machines could both drive the SAME `pending` row and
 * both submit a deposit — a double-mint / operator-fund leak. The
 * defense mirrors the classic payout worker exactly (INV-9):
 *   (a) the sweep selects candidate rows `FOR UPDATE SKIP LOCKED`, so
 *       concurrent sweeps pull disjoint sets in the common case; and
 *   (b) `driveOneVaultEmission` claims `pending → depositing` via an
 *       atomic state-CAS UPDATE (`claimEmissionForDeposit`) that
 *       COMMITS before `depositToVault`'s network call — only one
 *       machine wins the guarded UPDATE, the loser no-ops.
 * A crash after the CAS leaves the row `depositing`; the next tick
 * re-drives it, re-attempting the deposit with the persisted
 * `deposit_tx_hash` so CF-18 dedups the on-chain tx. The CAS + CF-18
 * together survive the advisory-lock degradation; the advisory lock
 * and SKIP LOCKED are throughput layers on top, not the correctness
 * guarantee.
 *
 * ── Known cross-worker risk (NOT solved in V3) ─────────────────────
 * `depositToVault` / `transferShares` sign with the SAME
 * `LOOP_STELLAR_OPERATOR_SECRET` the classic payout-submit worker
 * uses for Horizon payments (ADR 016). Both independently call
 * `getAccount()` to read the operator's CURRENT sequence number and
 * build a tx against it. If the vault sweep and the classic payout
 * worker tick concurrently, they can race the SAME sequence number —
 * this module does not coordinate with `payments/payout-worker.ts`
 * beyond each individually retrying on failure. Mitigated in V3 only
 * by: (a) the sweep processes its own rows strictly SEQUENTIALLY
 * (never concurrent submits from within this module), and (b) a
 * sequence collision surfaces as a Soroban/Horizon submit error,
 * which both workers already treat as retryable, not a fund-loss
 * event. A real fix (a shared sequence lock across worker types, or
 * per-worker channel accounts per ADR 044) is follow-up work — flag
 * this explicitly in money-review.
 *
 * ── Single-driver-per-row (V7 re-drive shares the sweep lock) ───────
 * This is a DIFFERENT and STRONGER guarantee than the sequence-number
 * residual above (which is two DIFFERENT operations racing one
 * account): for a GIVEN `vault_emissions` row, exactly ONE driver ever
 * executes a step at a time. The sweep is fleet-wide single-flighted
 * via `withAdvisoryLock(vaultEmissionSweepLockKey())`, and the only
 * per-step CAS (`claimEmissionForDeposit`, `pending → depositing`)
 * guards just the FIRST transition. The admin re-drive
 * (`admin/vault-emission-redrive.ts`, V7) resumes a `failed` row to
 * `depositing`/`deposited`/`transferred` — SKIPPING that CAS — so it
 * would otherwise be an un-serialized SECOND driver of the same step
 * as a concurrent sweep tick (a genuine double-deposit/double-transfer
 * vector, NOT the accepted sequence-number residual). It is therefore
 * required to acquire the SAME `vaultEmissionSweepLockKey()` before it
 * drives; the two are mutually exclusive fleet-wide (whoever holds the
 * lock runs; the other skips/409s). Do NOT add a third driver of these
 * rows without the same lock.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db, withAdvisoryLock } from '../../db/client.js';
import {
  vaultEmissions,
  creditTransactions,
  userCredits,
  pendingPayouts,
  watchdogAlertState,
  type LoopVaultAssetCode,
  type LoopVaultNetwork,
} from '../../db/schema.js';
import { env } from '../../env.js';
import { MAINNET_NETWORK_PASSPHRASE } from '../../env/schema-helpers.js';
import { logger } from '../../logger.js';
import { isUniqueViolation } from '../../db/errors.js';
import {
  markWorkerStarted,
  markWorkerStopped,
  markWorkerTickFailure,
  markWorkerTickSuccess,
} from '../../runtime-health.js';
import { notifyVaultEmissionFailed, notifyVaultEmissionsStuck } from '../../discord.js';
import {
  getActiveVault,
  vaultsEnabled,
  recordSharePriceSnapshot,
  type LoopVaultRow,
} from './registry.js';
import {
  depositToVault,
  transferShares,
  readVaultState,
  resolveOperatorPublicKey,
} from './vault-client.js';
import { generatePayoutMemo } from '../payout-builder.js';
import { recordVaultOperatorMovement } from '../../treasury/vault-operator-movement.js';

const log = logger.child({ area: 'vault-emissions' });

export type VaultEmissionRow = typeof vaultEmissions.$inferSelect;

/** 1e5 stroops per minor unit — same LOOP-asset 7-decimal convention `credits/payout-builder.ts` documents; assumed to also hold for the vault's underlying USDC/EURC asset. */
const STROOPS_PER_MINOR = 100_000n;

/** Consecutive step failures before a row moves `-> 'failed'` and stops being auto-retried by the sweep. Mirrors `LOOP_PAYOUT_MAX_ATTEMPTS`'s default (5). */
export const VAULT_EMISSION_MAX_ATTEMPTS = 5;

/**
 * Slippage tolerance for the deposit's `minShares` floor, in basis
 * points below the CURRENT (fresh-read) expected share count. Not
 * operator-configurable via env in V3 (deliberately — this is a
 * money-moving default, not an ops knob; revisit if real vault
 * volatility needs a wider band).
 */
const DEPOSIT_SLIPPAGE_TOLERANCE_BPS = 50n; // 0.5%

export type VaultEmissionCurrency = 'USD' | 'EUR';

export function isVaultEligibleCurrency(currency: string): currency is VaultEmissionCurrency {
  return currency === 'USD' || currency === 'EUR';
}

export function vaultAssetForCurrency(currency: VaultEmissionCurrency): LoopVaultAssetCode {
  switch (currency) {
    case 'USD':
      return 'LOOPUSD';
    case 'EUR':
      return 'LOOPEUR';
  }
}

function currencyForVaultAsset(assetCode: LoopVaultAssetCode): VaultEmissionCurrency {
  switch (assetCode) {
    case 'LOOPUSD':
      return 'USD';
    case 'LOOPEUR':
      return 'EUR';
  }
}

/** Derives the live network from the SAME config the classic payout path resolves its Stellar network from — no separate vault-only network setting. */
export function currentVaultNetwork(): LoopVaultNetwork {
  return env.LOOP_STELLAR_NETWORK_PASSPHRASE === MAINNET_NETWORK_PASSPHRASE ? 'mainnet' : 'testnet';
}

// Transaction type accepted by `claimVaultEmission` — the same
// pattern `db/staff-roles.ts` / `payments/cursor-watchdog.ts` use for
// a helper that must run INSIDE a caller-owned transaction.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ClaimVaultEmissionArgs {
  orderId: string;
  userId: string;
  assetCode: LoopVaultAssetCode;
  network: LoopVaultNetwork;
  /** Cashback owed, in the vault's fiat currency's minor units. Must be > 0 (the table's own CHECK also enforces this). */
  cashbackMinor: bigint;
  toAddress: string;
}

/**
 * ADR 031 §D5 step 1 — the durable idempotency claim. MUST be called
 * from inside the SAME transaction as the order's `fulfilled`
 * transition (see `orders/fulfillment.ts`), BEFORE any on-chain
 * action. Fast + local — no network I/O, no Soroban call.
 *
 * Returns `true` when this call created the row (fresh claim);
 * `false` on a conflict — a `vault_emissions` row for this order
 * already exists. That should not happen in practice (the order's
 * own `state='procuring'` guard already makes a re-entrant
 * `markOrderFulfilled` a no-op before this code runs at all), but the
 * `ON CONFLICT DO NOTHING` is defence in depth, mirroring the classic
 * path's identical guard on `pending_payouts_order_unique`.
 */
export async function claimVaultEmission(tx: Tx, args: ClaimVaultEmissionArgs): Promise<boolean> {
  const inserted = await tx
    .insert(vaultEmissions)
    .values({
      orderId: args.orderId,
      userId: args.userId,
      assetCode: args.assetCode,
      network: args.network,
      cashbackMinor: args.cashbackMinor,
      toAddress: args.toAddress,
      state: 'pending',
    })
    .onConflictDoNothing({ target: vaultEmissions.orderId })
    .returning({ id: vaultEmissions.id });
  return inserted.length > 0;
}

/**
 * Cross-machine deposit claim (money-review #1647 P1). Atomic state-CAS
 * `pending → depositing`, COMMITTED before any Soroban call — the exact
 * shape of the payout worker's `markPayoutSubmitted` (`pending →
 * submitted`). Two machines racing the same `pending` row: only one
 * wins this guarded UPDATE (the `state='pending'` predicate), the loser
 * gets `null` and skips — so at most one machine ever deposits, even
 * when the fleet-wide sweep advisory lock has degraded on a pooler URL.
 *
 * Returns the claimed row (now `depositing`) on success, or `null` when
 * another machine already advanced it out of `pending`.
 */
async function claimEmissionForDeposit(id: string): Promise<VaultEmissionRow | null> {
  const [row] = await db
    .update(vaultEmissions)
    .set({ state: 'depositing' })
    .where(and(eq(vaultEmissions.id, id), eq(vaultEmissions.state, 'pending')))
    .returning();
  return row ?? null;
}

function underlyingAmountStroopsFor(row: VaultEmissionRow): bigint {
  return row.cashbackMinor * STROOPS_PER_MINOR;
}

/**
 * A fresh, bounded slippage floor for the deposit call — computed
 * from a LIVE `readVaultState` share-price read, never 0/1 (ADR 031
 * §D5 step 2's explicit requirement).
 *
 * KNOWN EDGE CASE (accepted, not engineered around): on a RESUME
 * (retrying a deposit whose tx already landed, found via the CF-18
 * `priorTxHash` pre-check), `depositToVault` still re-validates the
 * CHAIN-RETURNED `sharesMinted` against this freshly-recomputed
 * floor. If the share price moved between the original attempt and
 * the resume, a genuinely-fine landed deposit could — rarely — read
 * as violating a floor computed from a LATER price. That surfaces as
 * `VaultPostSubmitSlippageError`, which `recordStepFailure` treats
 * like any other step failure (retry, then `failed` after
 * `VAULT_EMISSION_MAX_ATTEMPTS`) — fail CLOSED to "needs an operator
 * look", never a silent loss (the deposit landed; nothing is missing,
 * only unreconciled).
 */
async function computeMinShares(
  vault: LoopVaultRow,
  underlyingAmountStroops: bigint,
): Promise<bigint> {
  const state = await readVaultState({ vault });
  const expectedShares = (underlyingAmountStroops * 1_000_000n) / state.sharePricePpm;
  const minShares = expectedShares - (expectedShares * DEPOSIT_SLIPPAGE_TOLERANCE_BPS) / 10_000n;
  if (minShares <= 0n) {
    throw new Error(
      `computeMinShares: computed non-positive minShares (${minShares}) for underlyingAmountStroops=${underlyingAmountStroops}, sharePricePpm=${state.sharePricePpm}`,
    );
  }
  return minShares;
}

async function recordStepFailure(row: VaultEmissionRow, err: unknown): Promise<VaultEmissionRow> {
  const attempts = row.attempts + 1;
  const lastError = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
  const terminal = attempts >= VAULT_EMISSION_MAX_ATTEMPTS;
  const [updated] = await db
    .update(vaultEmissions)
    .set({
      attempts,
      lastError,
      ...(terminal ? { state: 'failed' as const, failedAt: new Date() } : {}),
    })
    .where(eq(vaultEmissions.id, row.id))
    .returning();
  log.error(
    { err, vaultEmissionId: row.id, orderId: row.orderId, attempts, terminal },
    'vault emission step failed',
  );
  if (updated === undefined) {
    throw new Error(`vault_emissions update returned no row (id=${row.id})`);
  }
  // P1-2a: a terminal `failed` row is NOT auto-retried and would
  // otherwise be invisible to ops (log-only). Page the moment it goes
  // terminal so the stuck cashback is surfaced for reconciliation.
  if (terminal) {
    notifyVaultEmissionFailed({
      vaultEmissionId: updated.id,
      orderId: updated.orderId,
      userId: updated.userId,
      assetCode: updated.assetCode,
      cashbackMinor: updated.cashbackMinor.toString(),
      attempts,
      lastError,
    });
  }
  return updated;
}

async function depositStep(row: VaultEmissionRow, vault: LoopVaultRow): Promise<VaultEmissionRow> {
  try {
    const underlyingAmount = underlyingAmountStroopsFor(row);
    const minShares = await computeMinShares(vault, underlyingAmount);
    const result = await depositToVault({
      vault,
      underlyingAmount,
      minShares,
      ...(row.depositTxHash !== null ? { priorTxHash: row.depositTxHash } : {}),
      onSigned: async (txHash) => {
        // CF-18: persist BEFORE submit so a crash after signing still
        // has a hash to resume from.
        await db
          .update(vaultEmissions)
          .set({ depositTxHash: txHash })
          .where(eq(vaultEmissions.id, row.id));
      },
    });
    const [updated] = await db
      .update(vaultEmissions)
      .set({
        state: 'deposited',
        depositTxHash: result.txHash,
        sharesMinted: result.sharesMinted,
        minSharesUsed: minShares,
        depositedAt: new Date(),
      })
      .where(eq(vaultEmissions.id, row.id))
      .returning();
    if (updated === undefined) {
      throw new Error(`vault_emissions update returned no row (id=${row.id}, deposit step)`);
    }
    // V5 (ADR 031 §D4): explain this USDC-denominated outflow to R3-1
    // (`treasury/hot-float-reconciliation.ts`) — best-effort, and
    // placed AFTER the state transition commits so a crash before this
    // point means depositStep re-enters on retry (this call happens
    // again, still safe — the row is only 'deposited' once this
    // update has already landed) while a crash AFTER this point never
    // re-enters depositStep for this row (it's no longer 'depositing'),
    // so at worst this note is missed once rather than double-recorded.
    await recordVaultOperatorMovement({
      vault,
      direction: 'out',
      amountStroops: result.amountsUsed.reduce((sum, amount) => sum + amount, 0n),
      reason: `Vault emission deposit for order ${row.orderId} (vault_emissions ${row.id})`,
    });
    return updated;
  } catch (err) {
    return recordStepFailure(row, err);
  }
}

async function transferStep(row: VaultEmissionRow, vault: LoopVaultRow): Promise<VaultEmissionRow> {
  try {
    if (row.sharesMinted === null) {
      throw new Error(`invariant: vault emission ${row.id} is 'deposited' with no sharesMinted`);
    }
    const operatorPublicKey = resolveOperatorPublicKey();
    const result = await transferShares({
      vault,
      from: operatorPublicKey,
      to: row.toAddress,
      // INV-V1: always THIS row's own sharesMinted — see module header.
      amount: row.sharesMinted,
      signWith: 'operator',
      ...(row.transferTxHash !== null ? { priorTxHash: row.transferTxHash } : {}),
      onSigned: async (txHash) => {
        await db
          .update(vaultEmissions)
          .set({ transferTxHash: txHash })
          .where(eq(vaultEmissions.id, row.id));
      },
    });
    const [updated] = await db
      .update(vaultEmissions)
      .set({ state: 'transferred', transferTxHash: result.txHash, transferredAt: new Date() })
      .where(eq(vaultEmissions.id, row.id))
      .returning();
    if (updated === undefined) {
      throw new Error(`vault_emissions update returned no row (id=${row.id}, transfer step)`);
    }
    return updated;
  } catch (err) {
    return recordStepFailure(row, err);
  }
}

async function mirrorStep(row: VaultEmissionRow, vault: LoopVaultRow): Promise<VaultEmissionRow> {
  try {
    if (row.sharesMinted === null || row.transferTxHash === null) {
      throw new Error(
        `invariant: vault emission ${row.id} is 'transferred' with missing sharesMinted/transferTxHash`,
      );
    }
    const currency = currencyForVaultAsset(row.assetCode as LoopVaultAssetCode);

    let pendingPayoutId: string | null = null;
    try {
      await db.transaction(async (tx) => {
        // Lock-then-write (INV-2) — the SAME discipline
        // `orders/fulfillment.ts` / `credits/interest-mint.ts` use.
        await tx
          .select()
          .from(userCredits)
          .where(and(eq(userCredits.userId, row.userId), eq(userCredits.currency, currency)))
          .for('update');

        // The conserved mirror credit. `credit_transactions_reference_unique`
        // (type='cashback', reference_type='order', reference_id=orderId)
        // is the SAME fence the classic path relies on — a resumed
        // mirror step that already committed once hits this as a
        // 23505, caught below.
        await tx.insert(creditTransactions).values({
          userId: row.userId,
          type: 'cashback',
          amountMinor: row.cashbackMinor,
          currency,
          referenceType: 'order',
          referenceId: row.orderId,
        });
        await tx
          .insert(userCredits)
          .values({ userId: row.userId, currency, balanceMinor: row.cashbackMinor })
          .onConflictDoUpdate({
            target: [userCredits.userId, userCredits.currency],
            set: {
              balanceMinor: sql`${userCredits.balanceMinor} + ${row.cashbackMinor}`,
              updatedAt: sql`NOW()`,
            },
          });

        // Conservation-trigger audit row (INV-V1, module header) —
        // ALREADY confirmed with the real transfer txHash; never
        // picked up by the classic payout-submit worker (state !=
        // 'pending').
        const [payout] = await tx
          .insert(pendingPayouts)
          .values({
            userId: row.userId,
            orderId: null,
            kind: 'emission',
            assetCode: row.assetCode,
            assetIssuer: vault.shareAssetIssuer,
            toAddress: row.toAddress,
            amountStroops: row.cashbackMinor * STROOPS_PER_MINOR,
            memoText: generatePayoutMemo(),
            state: 'confirmed',
            txHash: row.transferTxHash,
            submittedAt: new Date(),
            confirmedAt: new Date(),
          })
          .returning({ id: pendingPayouts.id });
        if (payout === undefined) {
          throw new Error('pending_payouts insert returned no row (vault mirror step)');
        }
        pendingPayoutId = payout.id;
      });
    } catch (err) {
      if (isUniqueViolation(err, 'credit_transactions_reference_unique')) {
        // A prior attempt already committed the mirror credit (crash
        // between that commit and this row's own state update to
        // 'mirrored') — idempotency backstop, not the primary
        // mechanism (the fleet-wide sweep lock makes true concurrency
        // here unlikely). Advance state without crediting twice; the
        // `pendingPayoutId` link is lost on this rare path (accepted
        // — audit-trail linkage only, not a money-correctness gap).
        log.warn(
          { vaultEmissionId: row.id, orderId: row.orderId },
          'vault emission mirror step: credit_transactions row already exists — treating as already-mirrored',
        );
      } else {
        throw err;
      }
    }

    // Best-effort share-price snapshot. Never blocks advancing to
    // 'mirrored' — the emission already landed on-chain and the
    // mirror already committed above; a snapshot failure here must
    // not strand an otherwise-correct emission in a retry loop.
    try {
      const state = await readVaultState({ vault });
      await recordSharePriceSnapshot({
        assetCode: row.assetCode as LoopVaultAssetCode,
        network: row.network as LoopVaultNetwork,
        sharePricePpm: state.sharePricePpm,
      });
    } catch (err) {
      log.warn(
        { err, vaultEmissionId: row.id },
        'vault emission mirror step: share-price snapshot failed (non-fatal)',
      );
    }

    const [updated] = await db
      .update(vaultEmissions)
      .set({
        state: 'mirrored',
        mirroredAt: new Date(),
        ...(pendingPayoutId !== null ? { pendingPayoutId } : {}),
      })
      .where(eq(vaultEmissions.id, row.id))
      .returning();
    if (updated === undefined) {
      throw new Error(`vault_emissions update returned no row (id=${row.id}, mirror step)`);
    }
    return updated;
  } catch (err) {
    return recordStepFailure(row, err);
  }
}

export type VaultEmissionDriveOutcome =
  | 'depositing'
  | 'deposited'
  | 'transferred'
  | 'mirrored'
  | 'failed'
  | 'no_vault'
  /** The `pending → depositing` claim was lost to another machine — this call did nothing (money-review #1647 P1). */
  | 'claimed_elsewhere';

/**
 * Advances one `vault_emissions` row as far as it will go THIS call —
 * resumes from `row.state`, never re-runs an earlier step. Every step
 * internally catches its own errors (`recordStepFailure`), so this
 * never throws for an ordinary on-chain/DB failure; it only throws
 * for a genuine programming-invariant violation.
 *
 * A `pending` row is first CLAIMED via the `pending → depositing`
 * state-CAS (`claimEmissionForDeposit`) — committed before any Soroban
 * call — so a concurrent sweep on another machine (possible when the
 * fleet-wide advisory lock has degraded on a pooler URL) that lost the
 * CAS returns `claimed_elsewhere` and never deposits. See the module
 * header's cross-machine guard note.
 */
export async function driveOneVaultEmission(
  row: VaultEmissionRow,
): Promise<VaultEmissionDriveOutcome> {
  const vault = await getActiveVault(
    row.assetCode as LoopVaultAssetCode,
    row.network as LoopVaultNetwork,
  );
  if (vault === null) {
    log.error(
      {
        vaultEmissionId: row.id,
        orderId: row.orderId,
        assetCode: row.assetCode,
        network: row.network,
      },
      'vault emission: no active vault registered for this (asset, network) — row stays as-is for a future retry once the vault is (re)registered',
    );
    return 'no_vault';
  }

  let current = row;
  if (current.state === 'pending') {
    // Cross-machine claim: CAS pending → depositing, committed before
    // the deposit's network call. Loser of a race no-ops.
    const claimed = await claimEmissionForDeposit(current.id);
    if (claimed === null) return 'claimed_elsewhere';
    current = claimed;
  }
  if (current.state === 'depositing') {
    current = await depositStep(current, vault);
  }
  if (current.state === 'deposited') {
    current = await transferStep(current, vault);
  }
  if (current.state === 'transferred') {
    current = await mirrorStep(current, vault);
  }
  return current.state as VaultEmissionDriveOutcome;
}

// ─── Admin re-drive support (V7 — the recovery complement to the V5a stuck-watchdog page) ──
//
// `failed` is deliberately NOT auto-retried by the sweep (see the
// module header) — an operator has to look. The three functions below
// are the primitives `admin/vault-emission-redrive.ts` composes; they
// do NOT introduce a new state-machine flow (the task ADR 031 V7 was
// scoped against: "do NOT hand-roll a new flow") — they only (a) read
// a row by id, (b) work out which state a `failed` row should resume
// FROM, and (c) CAS it back into that state so `driveOneVaultEmission`
// (unchanged, above) can re-enter its normal step chain.

/** By id — the admin handler's only "does this row exist" read. */
export async function getVaultEmissionById(id: string): Promise<VaultEmissionRow | null> {
  const [row] = await db.select().from(vaultEmissions).where(eq(vaultEmissions.id, id));
  return row ?? null;
}

export type VaultEmissionRedriveResumeState = 'depositing' | 'deposited' | 'transferred';

/**
 * Infers the correct resume state for a `failed` row from its
 * persisted *_At landing markers — NEVER from `depositTxHash` /
 * `transferTxHash` alone, because those are persisted by `onSigned`
 * BEFORE submit (CF-18) and so can be set even when the step never
 * landed. `depositedAt` / `transferredAt` are set ONLY in the same
 * UPDATE that advances `state` past that step, so they are proof the
 * step's on-chain action + DB commit both landed:
 *
 *   - `transferredAt` set  → the transfer landed, only the mirror is
 *     outstanding. Resume at `'transferred'` (drive re-enters at
 *     `mirrorStep`; `transferStep` is never called again).
 *   - `depositedAt` set (transferredAt not) → the deposit landed, the
 *     transfer is outstanding (it may have been attempted —
 *     `transferTxHash` may already be non-null — or not). Resume at
 *     `'deposited'` (drive re-enters at `transferStep`, which
 *     verify-or-resubmits via `priorTxHash: row.transferTxHash` per
 *     CF-18 — it never blindly re-signs a fresh transfer for an
 *     already-landed one).
 *   - neither set → nothing has landed (the row may still have a
 *     `depositTxHash` from an aborted attempt). Resume at
 *     `'depositing'` (drive re-enters at `depositStep`, same
 *     verify-or-resubmit contract via `priorTxHash: row.depositTxHash`).
 *
 * A `failed` row can never have been claimed straight out of
 * `'pending'` — `claimEmissionForDeposit`'s CAS is a direct UPDATE,
 * not a `recordStepFailure` caller — so `'pending'` is never a valid
 * resume target here; every `failed` row was already at least
 * `'depositing'` when it exhausted its attempts.
 */
export function inferVaultEmissionResumeState(
  row: VaultEmissionRow,
): VaultEmissionRedriveResumeState {
  if (row.transferredAt !== null) return 'transferred';
  if (row.depositedAt !== null) return 'deposited';
  return 'depositing';
}

export type VaultEmissionReclaimResult =
  | { kind: 'not_found' }
  /** Row exists but was not `'failed'` at claim time (already redriven by a concurrent call, or moved on its own). */
  | { kind: 'not_failed'; row: VaultEmissionRow }
  | { kind: 'reclaimed'; row: VaultEmissionRow };

/**
 * Atomically reclaims a `failed` vault-emission row for re-drive: locks
 * the row (`FOR UPDATE`, so a concurrent redrive call serializes
 * behind this one rather than racing it), verifies it is still
 * `'failed'`, computes its resume target from the SAME locked row via
 * `inferVaultEmissionResumeState`, and CAS-updates
 * `state → resumeState, attempts → 0, lastError → null, failedAt →
 * null`. The `WHERE state = 'failed'` on the UPDATE is a second,
 * redundant guard against the row lock alone (defence in depth, same
 * belt-and-suspenders posture as every other CAS in this module).
 *
 * Does NOT drive the row — the caller (the admin handler) does that
 * via the ordinary `driveOneVaultEmission(row)`, exactly once, using
 * the row this function returns.
 */
export async function reclaimFailedVaultEmissionForRedrive(
  id: string,
): Promise<VaultEmissionReclaimResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(vaultEmissions)
      .where(eq(vaultEmissions.id, id))
      .for('update');
    if (row === undefined) return { kind: 'not_found' };
    if (row.state !== 'failed') return { kind: 'not_failed', row };
    const resumeState = inferVaultEmissionResumeState(row);
    const [updated] = await tx
      .update(vaultEmissions)
      .set({ state: resumeState, attempts: 0, lastError: null, failedAt: null })
      .where(and(eq(vaultEmissions.id, id), eq(vaultEmissions.state, 'failed')))
      .returning();
    if (updated === undefined) return { kind: 'not_failed', row };
    return { kind: 'reclaimed', row: updated };
  });
}

// ─── Sweep (crash-recovery + primary driver — mirrors credits/interest-mint.ts) ────

// Non-terminal states the sweep picks up. `depositing` is included so
// a row claimed-but-crashed before its deposit landed gets re-driven.
const SWEEP_STATES = ['pending', 'depositing', 'deposited', 'transferred'] as const;

/**
 * Fleet-wide single-flight key for the emission sweep. Exported (V7,
 * money-review #1652 P1) so the admin re-drive
 * (`admin/vault-emission-redrive.ts`) can acquire the SAME lock before
 * it drives a reclaimed row. V3 is single-driver-designed: the only
 * per-step CAS is `pending → depositing`, and the admin re-drive
 * resumes a `failed` row to `depositing`/`deposited`/`transferred`
 * (never `pending`), so that CAS is SKIPPED and the reclaimed state is
 * in `SWEEP_STATES` — a concurrent sweep tick would otherwise
 * `SELECT … FOR UPDATE SKIP LOCKED` the same row and drive the same
 * un-CAS'd step, and if the two Soroban submits STAGGER (rather than
 * collide on the operator sequence number) BOTH could land → a
 * double-deposit / double-transfer of value (the DB-fenced mirror step
 * prevents a double mirror-credit, so the exposure is on-chain
 * share/USDC drift, caught post-hoc by the V5 watchers — hence P1 not
 * P0). Serialising the re-drive under this lock restores V3's
 * single-driver guarantee: while the re-drive holds it the sweep's
 * `withAdvisoryLock` returns `{ ran: false }` and skips entirely, and
 * vice-versa (the re-drive 409s "sweep in progress").
 */
export function vaultEmissionSweepLockKey(): bigint {
  const digest = createHash('sha256').update('loop:vault-emission-sweep').digest();
  const raw =
    (BigInt(digest[0]!) << 56n) |
    (BigInt(digest[1]!) << 48n) |
    (BigInt(digest[2]!) << 40n) |
    (BigInt(digest[3]!) << 32n) |
    (BigInt(digest[4]!) << 24n) |
    (BigInt(digest[5]!) << 16n) |
    (BigInt(digest[6]!) << 8n) |
    BigInt(digest[7]!);
  return BigInt.asIntN(64, raw);
}

export interface VaultEmissionSweepResult {
  skippedLocked: boolean;
  considered: number;
  mirrored: number;
  /** Advanced a step but not (yet) mirrored — includes rows that stayed on their current state after a non-terminal failure. */
  advanced: number;
  failed: number;
  noVault: number;
  /** Rows whose `pending → depositing` claim was lost to a concurrent sweep (money-review #1647 P1). Benign. */
  claimedElsewhere: number;
  /** `driveOneVaultEmission` threw unexpectedly — should not happen (see its doc comment). */
  errors: number;
}

/**
 * One sweep pass, fleet-wide single-flighted (mirrors A8 / S4-8's
 * established pattern) — only one machine drains `vault_emissions`
 * per tick, which is also what keeps this module's rows from
 * concurrently signing with the operator account against each other
 * (see the module header's cross-worker-risk note for the residual
 * this does NOT cover: races against the CLASSIC payout worker).
 */
export async function runVaultEmissionSweepTick(args?: {
  batchSize?: number;
}): Promise<VaultEmissionSweepResult> {
  const locked = await withAdvisoryLock(vaultEmissionSweepLockKey(), () =>
    runVaultEmissionSweepLocked(args),
  );
  if (!locked.ran) {
    return {
      skippedLocked: true,
      considered: 0,
      mirrored: 0,
      advanced: 0,
      failed: 0,
      noVault: 0,
      claimedElsewhere: 0,
      errors: 0,
    };
  }
  return locked.value;
}

async function runVaultEmissionSweepLocked(args?: {
  batchSize?: number;
}): Promise<VaultEmissionSweepResult> {
  const result: VaultEmissionSweepResult = {
    skippedLocked: false,
    considered: 0,
    mirrored: 0,
    advanced: 0,
    failed: 0,
    noVault: 0,
    claimedElsewhere: 0,
    errors: 0,
  };
  if (!vaultsEnabled()) return result;

  const batchSize = args?.batchSize ?? 50;
  const rows = await db
    .select()
    .from(vaultEmissions)
    .where(inArray(vaultEmissions.state, [...SWEEP_STATES]))
    .orderBy(vaultEmissions.createdAt)
    .limit(batchSize)
    // money-review #1647 P1: skip rows another machine's sweep is
    // mid-claim on, so concurrent sweeps pull disjoint candidate sets
    // (throughput layer; the per-row `pending → depositing` CAS in
    // `driveOneVaultEmission` is the durable correctness guarantee).
    // Mirrors `listClaimablePayouts`'s `.for('update', { skipLocked })`.
    .for('update', { skipLocked: true });
  result.considered = rows.length;

  // Sequential, deliberately — see the module header's cross-worker
  // sequence-number note. Never Promise.all this loop.
  for (const row of rows) {
    try {
      const outcome = await driveOneVaultEmission(row);
      switch (outcome) {
        case 'mirrored':
          result.mirrored++;
          break;
        case 'failed':
          result.failed++;
          break;
        case 'no_vault':
          result.noVault++;
          break;
        case 'claimed_elsewhere':
          result.claimedElsewhere++;
          break;
        case 'depositing':
        case 'deposited':
        case 'transferred':
          // Made it further than before (or stayed on the same
          // non-terminal state after a retryable step failure) —
          // either way, not yet mirrored/failed/no_vault.
          result.advanced++;
          break;
      }
    } catch (err) {
      result.errors++;
      log.error(
        { err, vaultEmissionId: row.id, orderId: row.orderId },
        'vault emission sweep: drive threw unexpectedly (should not happen — driveOneVaultEmission catches internally)',
      );
    }
  }
  return result;
}

// ─── Stuck-emission watchdog (money-review #1647 P1-2b) ────────────────────
//
// The `failed`-row page (recordStepFailure) only fires for rows that
// EXHAUSTED their attempts. A row STUCK in an in-flight state without
// exhausting attempts — the sweep worker is down, Soroban RPC is
// unreachable, or the operator account is sequence-contended so every
// deposit/transfer transiently fails — would never reach `failed` and
// would otherwise be invisible. This watchdog pages once per incident
// when any row has sat in `depositing`/`deposited`/`transferred` past
// the threshold, mirroring `stuck-payout-watchdog.ts` exactly:
// single-flighted fleet-wide via `pg_try_advisory_xact_lock`, fire-
// once/re-arm state persisted in `watchdog_alert_state`, confirmed-
// delivery (persist active=true only after the send resolves).

const VAULT_EMISSION_STUCK_STATES = ['depositing', 'deposited', 'transferred'] as const;

/** `watchdog_alert_state` row key for the stuck-vault-emission watchdog. */
const VAULT_EMISSION_STUCK_ALERT_NAME = 'vault-emission-stuck-watchdog';

export const VAULT_EMISSION_STUCK_WATCHDOG_INTERVAL_MS = 60 * 1000;

function vaultEmissionStuckWatchdogLockKey(): bigint {
  const digest = createHash('sha256').update('loop:vault-emission-stuck-watchdog').digest();
  const raw =
    (BigInt(digest[0]!) << 56n) |
    (BigInt(digest[1]!) << 48n) |
    (BigInt(digest[2]!) << 40n) |
    (BigInt(digest[3]!) << 32n) |
    (BigInt(digest[4]!) << 24n) |
    (BigInt(digest[5]!) << 16n) |
    (BigInt(digest[6]!) << 8n) |
    BigInt(digest[7]!);
  return BigInt.asIntN(64, raw);
}

export interface VaultEmissionStuckWatchdogResult {
  skippedLocked: boolean;
  notified: boolean;
}

/**
 * Single-flighted stuck-emission probe. Same shape + at-least-once
 * confirmed-delivery contract as `runStuckPayoutWatchdog`.
 */
export async function runVaultEmissionStuckWatchdog(args?: {
  thresholdMinutes?: number;
  limit?: number;
}): Promise<VaultEmissionStuckWatchdogResult> {
  const thresholdMinutes = args?.thresholdMinutes ?? 15;
  const limit = args?.limit ?? 20;
  if (!vaultsEnabled()) return { skippedLocked: false, notified: false };
  return await db.transaction(async (tx) => {
    const lockResult = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(${vaultEmissionStuckWatchdogLockKey()}) AS locked`,
    );
    const lockRows = Array.isArray(lockResult)
      ? (lockResult as Array<{ locked: boolean }>)
      : ((lockResult as { rows?: Array<{ locked: boolean }> }).rows ?? []);
    if (lockRows[0]?.locked !== true) {
      return { skippedLocked: true, notified: false };
    }

    const [alertRow] = await tx
      .select({ alertActive: watchdogAlertState.alertActive })
      .from(watchdogAlertState)
      .where(eq(watchdogAlertState.watchdogName, VAULT_EMISSION_STUCK_ALERT_NAME));
    const alertActive = alertRow?.alertActive ?? false;

    const rows = await tx
      .select({
        id: vaultEmissions.id,
        state: vaultEmissions.state,
        assetCode: vaultEmissions.assetCode,
        createdAt: vaultEmissions.createdAt,
      })
      .from(vaultEmissions)
      .where(
        and(
          inArray(vaultEmissions.state, [...VAULT_EMISSION_STUCK_STATES]),
          sql`${vaultEmissions.createdAt} < NOW() - make_interval(mins => ${thresholdMinutes})`,
        ),
      )
      .orderBy(vaultEmissions.createdAt)
      .limit(limit);

    if (rows.length === 0) {
      if (alertActive) {
        await tx
          .insert(watchdogAlertState)
          .values({ watchdogName: VAULT_EMISSION_STUCK_ALERT_NAME, alertActive: false })
          .onConflictDoUpdate({
            target: watchdogAlertState.watchdogName,
            set: { alertActive: false, updatedAt: sql`NOW()` },
          });
      }
      return { skippedLocked: false, notified: false };
    }
    if (alertActive) return { skippedLocked: false, notified: false };

    const oldest = rows.reduce((max, row) => {
      const ageMin = Math.round((Date.now() - row.createdAt.getTime()) / 60_000);
      return ageMin > max ? ageMin : max;
    }, 0);
    const uniqueStates = [...new Set(rows.map((r) => r.state))].sort().join(', ');
    const first = rows[0] ?? null;

    const delivered = await notifyVaultEmissionsStuck({
      rowCount: rows.length,
      thresholdMinutes,
      oldestAgeMinutes: oldest,
      states: uniqueStates,
      vaultEmissionId: first?.id ?? null,
      assetCode: first?.assetCode ?? null,
    });
    if (!delivered) return { skippedLocked: false, notified: false };
    await tx
      .insert(watchdogAlertState)
      .values({ watchdogName: VAULT_EMISSION_STUCK_ALERT_NAME, alertActive: true })
      .onConflictDoUpdate({
        target: watchdogAlertState.watchdogName,
        set: { alertActive: true, updatedAt: sql`NOW()` },
      });
    return { skippedLocked: false, notified: true };
  });
}

async function tickVaultEmissionStuckWatchdog(): Promise<void> {
  try {
    await runVaultEmissionStuckWatchdog();
  } catch (err) {
    log.error({ err }, 'Vault-emission stuck watchdog tick failed');
  }
}

/** Tick cadence — mirrors `LOOP_PAYOUT_WORKER_INTERVAL_SECONDS`'s default pacing (a Soroban submit + ledger-close is comparable latency to a classic Stellar payout). */
export const VAULT_EMISSION_SWEEP_TICK_INTERVAL_MS = 30_000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let stuckWatchdogTimer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

export async function tickVaultEmissionSweep(): Promise<void> {
  if (tickInFlight) {
    log.warn('Vault-emission sweep tick skipped — prior tick still running');
    return;
  }
  tickInFlight = true;
  try {
    const r = await runVaultEmissionSweepTick();
    if (!r.skippedLocked && r.considered > 0) {
      log.info(
        {
          considered: r.considered,
          mirrored: r.mirrored,
          advanced: r.advanced,
          failed: r.failed,
          noVault: r.noVault,
          claimedElsewhere: r.claimedElsewhere,
          errors: r.errors,
        },
        'Vault-emission sweep tick complete',
      );
    }
    // P1-2c: a terminal `failed` row (or an unexpected drive error)
    // this tick must NOT read as a silently-healthy tick. Surface it
    // through `markWorkerTickFailure` so the worker-stale/degraded
    // signal on /health fires and the Discord failed-emission page
    // (recordStepFailure) isn't the only trace. `failed` counts rows
    // that went terminal THIS tick (terminal rows leave SWEEP_STATES,
    // so they aren't re-counted) — a discrete event, not a standing
    // state, so subsequent clean ticks re-mark success.
    if (r.failed > 0 || r.errors > 0) {
      markWorkerTickFailure(
        'vault_emission_sweep',
        new Error(
          `vault-emission sweep: ${r.failed} row(s) went terminal-failed, ${r.errors} unexpected drive error(s) this tick`,
        ),
      );
    } else {
      markWorkerTickSuccess('vault_emission_sweep');
    }
  } catch (err) {
    markWorkerTickFailure('vault_emission_sweep', err);
    log.error({ err }, 'Vault-emission sweep tick failed');
  } finally {
    tickInFlight = false;
  }
}

/**
 * Starts the periodic vault-emission sweep. Gated at the caller
 * (`index.ts`) by `LOOP_WORKERS_ENABLED` + `vaultsEnabled()` — with
 * either off, `orders/fulfillment.ts`'s gated fork never claims a
 * `vault_emissions` row in the first place, so an unstarted sweep
 * here is consistent, not merely inert.
 */
export function startVaultEmissionSweep(args?: {
  intervalMs?: number;
  stuckWatchdogIntervalMs?: number;
}): void {
  stopVaultEmissionSweep();
  const intervalMs = args?.intervalMs ?? VAULT_EMISSION_SWEEP_TICK_INTERVAL_MS;
  markWorkerStarted('vault_emission_sweep', { staleAfterMs: Math.max(intervalMs * 3, 60_000) });
  log.info({ intervalMs }, 'Starting vault-emission sweep worker (ADR 031 V3)');
  setImmediate(() => {
    void tickVaultEmissionSweep();
  });
  sweepTimer = setInterval(() => {
    void tickVaultEmissionSweep();
  }, intervalMs);
  sweepTimer.unref();

  // P1-2b: the stuck-emission watchdog runs on its own (slower)
  // cadence, single-flighted fleet-wide, sharing the sweep worker's
  // lifecycle like `stuck-payout-watchdog` shares the payout worker's.
  const watchdogIntervalMs =
    args?.stuckWatchdogIntervalMs ?? VAULT_EMISSION_STUCK_WATCHDOG_INTERVAL_MS;
  stuckWatchdogTimer = setInterval(() => {
    void tickVaultEmissionStuckWatchdog();
  }, watchdogIntervalMs);
  stuckWatchdogTimer.unref();
}

export function stopVaultEmissionSweep(): void {
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  if (stuckWatchdogTimer !== null) {
    clearInterval(stuckWatchdogTimer);
    stuckWatchdogTimer = null;
  }
  markWorkerStopped('vault_emission_sweep');
}
