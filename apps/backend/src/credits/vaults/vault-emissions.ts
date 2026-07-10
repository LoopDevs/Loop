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
 *   pending → deposited → transferred → mirrored   (+ failed)
 *
 *   1. pending      claimed (`claimVaultEmission`), nothing on-chain yet.
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
 * re-submitting. Resuming from `deposited` or `transferred` does NOT
 * re-run the earlier step at all — the state machine only ever
 * advances forward from `row.state`.
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
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db, withAdvisoryLock } from '../../db/client.js';
import {
  vaultEmissions,
  creditTransactions,
  userCredits,
  pendingPayouts,
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
  | 'pending'
  | 'deposited'
  | 'transferred'
  | 'mirrored'
  | 'failed'
  | 'no_vault';

/**
 * Advances one `vault_emissions` row as far as it will go THIS call —
 * resumes from `row.state`, never re-runs an earlier step. Every step
 * internally catches its own errors (`recordStepFailure`), so this
 * never throws for an ordinary on-chain/DB failure; it only throws
 * for a genuine programming-invariant violation.
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

// ─── Sweep (crash-recovery + primary driver — mirrors credits/interest-mint.ts) ────

const SWEEP_STATES = ['pending', 'deposited', 'transferred'] as const;

function vaultEmissionSweepLockKey(): bigint {
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
    errors: 0,
  };
  if (!vaultsEnabled()) return result;

  const batchSize = args?.batchSize ?? 50;
  const rows = await db
    .select()
    .from(vaultEmissions)
    .where(inArray(vaultEmissions.state, [...SWEEP_STATES]))
    .orderBy(vaultEmissions.createdAt)
    .limit(batchSize);
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
        case 'pending':
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

/** Tick cadence — mirrors `LOOP_PAYOUT_WORKER_INTERVAL_SECONDS`'s default pacing (a Soroban submit + ledger-close is comparable latency to a classic Stellar payout). */
export const VAULT_EMISSION_SWEEP_TICK_INTERVAL_MS = 30_000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;
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
          errors: r.errors,
        },
        'Vault-emission sweep tick complete',
      );
    }
    markWorkerTickSuccess('vault_emission_sweep');
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
export function startVaultEmissionSweep(args?: { intervalMs?: number }): void {
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
}

export function stopVaultEmissionSweep(): void {
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  markWorkerStopped('vault_emission_sweep');
}
