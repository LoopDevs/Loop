/**
 * Nightly on-chain interest mints (ADR 031 / ADR 036 Phase D).
 *
 * Replaces the legacy off-chain-only accrual (`accrue-interest.ts` —
 * hard-gated off while `LOOP_INTEREST_ONCHAIN_ENABLED=true`; see
 * `interest-scheduler.ts`). Under ADR 036 the on-chain LOOP in the
 * user's wallet is the authoritative balance and `user_credits` is
 * the liability mirror, so interest must move BOTH halves in one
 * logical operation:
 *
 *   on-chain  : + mint to the user's wallet (payment FROM the issuer
 *               account — a native Stellar mint), driven through the
 *               existing payout queue (`kind='interest_mint'`, signed
 *               with the per-asset issuer keypair).
 *   mirror    : + `credit_transactions type='interest'` and a
 *               `user_credits` bump, written in the SAME DB txn that
 *               enqueues the mint.
 *
 * ── Scheduling ──────────────────────────────────────────────────────
 * Tick-based, not wall-clock cron: the worker ticks every few minutes
 * and computes the period key (`YYYY-MM-DD`, current UTC date). A
 * `watcher_cursors` row (`name='interest_mint'`) records the last
 * fully-processed period; a tick whose period matches the cursor is a
 * cheap no-op. A process that was down across midnight therefore
 * self-heals: the first tick after boot sees cursor ≠ today and runs
 * the night's pass. A UTC day during which the process never ran at
 * all is NOT retro-minted — no balance snapshot exists for it, and
 * fabricating one from a later balance would be guesswork; the gap is
 * logged loudly so ops can compensate deliberately (admin emission)
 * if desired.
 *
 * ── Eligibility ─────────────────────────────────────────────────────
 * Users with `wallet_provisioning='activated'` holding > 0 of a LOOP
 * asset whose issuer SIGNER is configured
 * (`LOOP_STELLAR_<ASSET>_ISSUER_SECRET`, validated at boot). The
 * balance is a Horizon trustline read snapshotted into
 * `interest_mint_snapshots` for auditability — every eligible holder
 * gets exactly one snapshot row per (asset, night).
 *
 * ── Math (all bigint, ADR 009 flooring discipline) ─────────────────
 *   accrual = floor(balance × apyBps / (10_000 × 365))   [stroops]
 *   payable = carry_before + accrual
 *   minted_minor = payable / 100_000                     [minor units]
 *   carry_after  = payable % 100_000                     [stroops]
 *
 * The accrual is floored to 7 decimals (1 stroop) and sub-stroop dust
 * is skipped, per ADR 031. The mirror, however, is integer MINOR
 * units (1 minor = 1e5 stroops): minting the raw 7-decimal accrual
 * while crediting a rounded mirror would diverge the asset-drift
 * equation monotonically. Both halves therefore move by exactly
 * `minted_minor` and the sub-minor fraction accumulates in the
 * snapshot row's carry until it crosses a whole minor unit — over
 * time every user receives exactly their floored 7-decimal accrual,
 * and every individual night is perfectly drift-neutral.
 *
 * ── Idempotency / crash consistency ────────────────────────────────
 * Per user+asset+night, one DB transaction writes: snapshot row +
 * (when minted_minor > 0) interest ledger row + mirror bump + payout
 * row. Two fences make a re-run of the same period a no-op: the
 * snapshot unique index and the pre-existing period-cursor partial
 * unique index on `credit_transactions`. A crash mid-sweep leaves
 * the cursor unadvanced; the next tick re-runs the period and the
 * fences skip completed users. The payout worker then drives the
 * on-chain mint with the existing retry/classify machinery — a crash
 * between the ledger txn and the Stellar submit re-drives from the
 * queue without double-crediting.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { db, withAdvisoryLock } from '../db/client.js';
import {
  creditTransactions,
  interestMintSnapshots,
  pendingPayouts,
  userCredits,
  users,
  watcherCursors,
} from '../db/schema.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import type { HomeCurrency, LoopAssetCode } from '@loop/shared';
import { configuredLoopPayableAssets } from './payout-asset.js';
import { generatePayoutMemo } from './payout-builder.js';
import { resolveIssuerSigners } from '../payments/issuer-signers.js';
import { getAccountTrustlines } from '../payments/horizon-trustlines.js';
import {
  markWorkerStarted,
  markWorkerStopped,
  markWorkerTickFailure,
  markWorkerTickSuccess,
} from '../runtime-health.js';
import { isUniqueViolationOnAny } from '../db/errors.js';

/**
 * The two unique-index fences a single `mintOneUser` transaction can
 * hit (the snapshot table and the credit-transactions period-cursor
 * index, migrations 0041 / 0012) — a violation of either means this
 * (user, asset, night) was already processed by a prior run. Named
 * explicitly (rather than matching ANY `23505`) so an unrelated
 * unique violation isn't silently swallowed as "already minted" —
 * see AUDIT-2 finding D.
 */
const INTEREST_MINT_IDEMPOTENCY_CONSTRAINTS = [
  'interest_mint_snapshots_user_asset_period_unique',
  'credit_transactions_interest_period_unique',
] as const;

const log = logger.child({ area: 'interest-mint' });

/** 1e5 stroops per minor unit — LOOP assets are 1:1 with fiat at 7 decimals. */
const STROOPS_PER_MINOR = 100_000n;

/** `watcher_cursors` row name holding the last fully-processed period. */
export const INTEREST_MINT_CURSOR_NAME = 'interest_mint';

function interestMintLockKey(): bigint {
  const digest = createHash('sha256').update('loop:interest-mint-worker').digest();
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

/**
 * On-chain-mint-eligible LOOP codes (2026-06-15 cold audit v-wallet
 * P0, re-confirmed 2026-06-30 — "still open, byte-for-byte
 * unchanged"). Per ADR 031 v7 only GBPLOOP is the classic 1:1-backed
 * asset; USDLOOP/EURLOOP (renamed LOOPUSD/LOOPEUR in v7, rename not
 * yet applied to code) are DeFindex vault SHARES whose yield is
 * price growth, not new supply — minting them here the same way as
 * GBPLOOP creates unbacked tokens. The vault-share yield path isn't
 * built yet, so the safe interim behaviour is simply not minting
 * on-chain interest for those codes at all; a fiat/USD or EUR holder
 * accrues no on-chain interest until DeFindex vault accounting
 * lands. Revisit this allowlist when that path exists.
 */
export const ONCHAIN_MINT_ELIGIBLE_ASSETS: ReadonlySet<LoopAssetCode> = new Set(['GBPLOOP']);

/**
 * Tick cadence. Cheap when the period is already processed (one
 * cursor read), so a short interval just narrows how long after
 * 00:00 UTC the night's pass starts.
 */
export const INTEREST_MINT_TICK_INTERVAL_MS = 10 * 60_000;

/**
 * CON-04: hard lease on how long the fleet-wide mint lock may be held.
 *
 * `withAdvisoryLock` takes a SESSION lock on a dedicated reserved
 * connection and holds it for the whole `fn`, and its own docstring
 * warns that "the CALLER is responsible for bounding how long `fn`
 * runs … because a lock held across unbounded network I/O by a
 * hung-but-alive leader would otherwise stall the whole fleet." The
 * mint sweep interleaves a per-user Horizon trustline read (network,
 * only 30s-cached — cold across the 10-minute tick cadence) with each
 * user's DB write, so a blackholed Horizon that accepts TCP and never
 * responds would pin the fleet-wide lock indefinitely and stall
 * interest minting fleet-wide for the rest of the UTC day. The payout
 * worker (`runPayoutTick`) already solves the identical shape by racing
 * its locked tick body against a lease deadline; this is that pattern.
 *
 * On lease expiry we release the lock and return WITHOUT advancing the
 * cursor, so the next tick simply re-runs the period and the per-user
 * idempotency fences (snapshot + credit-transactions unique indexes)
 * skip everyone already minted — a cut-off sweep still makes forward
 * progress and NEVER double-mints. Chosen generous enough (5 min, well
 * under the 10-min tick cadence so ticks can't overlap) that a healthy
 * sweep completes in one pass, while capping a hung leader's fleet
 * stall at one lease instead of forever.
 */
export const INTEREST_MINT_TICK_LEASE_MS = 5 * 60_000;

/** Sentinel resolved by the lease timer when the mint sweep overruns. */
const TICK_LEASE_TIMED_OUT = Symbol('interest-mint-tick-lease-timeout');

/** Fiat backing each LOOP code — 1:1 by design (ADR 015). */
function fiatOf(code: LoopAssetCode): HomeCurrency {
  switch (code) {
    case 'USDLOOP':
      return 'USD';
    case 'GBPLOOP':
      return 'GBP';
    case 'EURLOOP':
      return 'EUR';
  }
}

/** UTC calendar date as `YYYY-MM-DD` — the period-cursor shape ADR 009 pins. */
export function utcPeriodCursor(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * One night's raw accrual in stroops, floored to 7 decimals (ADR 031:
 * APR/365 per night). ≤ 0 inputs and sub-stroop dust both yield 0n.
 */
export function computeNightlyAccrualStroops(balanceStroops: bigint, apyBps: number): bigint {
  if (balanceStroops <= 0n) return 0n;
  if (apyBps <= 0 || !Number.isInteger(apyBps)) return 0n;
  return (balanceStroops * BigInt(apyBps)) / (10_000n * 365n);
}

/**
 * Splits carry + accrual into the whole-minor-unit payout and the
 * sub-minor remainder that carries to the next night. Conservation:
 * `carry + accrual = mintedMinor × 1e5 + carryAfter` (also a DB CHECK
 * on the snapshot table).
 */
export function splitPayable(
  carryBeforeStroops: bigint,
  accrualStroops: bigint,
): { mintedMinor: bigint; carryAfterStroops: bigint } {
  const payable = carryBeforeStroops + accrualStroops;
  return {
    mintedMinor: payable / STROOPS_PER_MINOR,
    carryAfterStroops: payable % STROOPS_PER_MINOR,
  };
}

async function readMintCursor(): Promise<string | null> {
  const rows = await db
    .select({ cursor: watcherCursors.cursor })
    .from(watcherCursors)
    .where(eq(watcherCursors.name, INTEREST_MINT_CURSOR_NAME));
  return rows[0]?.cursor ?? null;
}

async function writeMintCursor(period: string): Promise<void> {
  await db
    .insert(watcherCursors)
    .values({ name: INTEREST_MINT_CURSOR_NAME, cursor: period, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: watcherCursors.name,
      set: { cursor: period, updatedAt: new Date() },
    });
}

type MintUserOutcome = 'minted' | 'accrued_only' | 'skipped_zero_balance' | 'skipped_already';

interface MintOneArgs {
  userId: string;
  walletAddress: string;
  asset: { code: LoopAssetCode; issuer: string };
  period: string;
  apyBps: number;
}

/**
 * Processes one (user, asset) pair for one period. Returns the
 * outcome; throws on Horizon/DB infrastructure errors (the sweep
 * records and continues so one bad row doesn't starve the night).
 */
async function mintOneUser(args: MintOneArgs): Promise<{
  outcome: MintUserOutcome;
  mintedMinor: bigint;
}> {
  const currency = fiatOf(args.asset.code);

  // Horizon trustline read (30s-cached). The on-chain balance is the
  // authoritative base for interest (ADR 036 — holders-only; see the
  // plan doc for the earned-but-not-yet-emitted open question).
  const snapshot = await getAccountTrustlines(args.walletAddress);
  const line = snapshot.trustlines.get(`${args.asset.code}::${args.asset.issuer}`);
  const balanceStroops = line?.balanceStroops ?? 0n;
  if (!snapshot.accountExists || balanceStroops <= 0n) {
    return { outcome: 'skipped_zero_balance', mintedMinor: 0n };
  }

  const accrualStroops = computeNightlyAccrualStroops(balanceStroops, args.apyBps);

  try {
    return await db.transaction(async (tx) => {
      // Latest snapshot carries the sub-minor remainder forward. The
      // unique index (user, asset, period) makes the ordered read
      // cheap; a row already at this period means a prior run (or a
      // racing worker) handled this user tonight.
      const prior = await tx
        .select({
          periodCursor: interestMintSnapshots.periodCursor,
          carryAfterStroops: interestMintSnapshots.carryAfterStroops,
        })
        .from(interestMintSnapshots)
        .where(
          and(
            eq(interestMintSnapshots.userId, args.userId),
            eq(interestMintSnapshots.assetCode, args.asset.code),
          ),
        )
        .orderBy(desc(interestMintSnapshots.periodCursor))
        .limit(1);
      const latest = prior[0];
      if (latest !== undefined && latest.periodCursor === args.period) {
        return { outcome: 'skipped_already' as const, mintedMinor: 0n };
      }
      const carryBeforeStroops = latest?.carryAfterStroops ?? 0n;
      const { mintedMinor, carryAfterStroops } = splitPayable(carryBeforeStroops, accrualStroops);

      // Snapshot first — the audit row exists even on accrue-only
      // nights (mintedMinor = 0), and its unique index is the
      // per-night fence for everything below (same txn).
      await tx.insert(interestMintSnapshots).values({
        userId: args.userId,
        assetCode: args.asset.code,
        assetIssuer: args.asset.issuer,
        currency,
        periodCursor: args.period,
        balanceStroops,
        accrualStroops,
        carryBeforeStroops,
        carryAfterStroops,
        mintedMinor,
      });

      if (mintedMinor <= 0n) {
        return { outcome: 'accrued_only' as const, mintedMinor: 0n };
      }

      // Mirror credit (ADR 036 "nightly interest: + LOOP mint to user
      // / credit the mirror, same op"). The period-cursor partial
      // unique index on credit_transactions is the second idempotency
      // fence — it also fences against the legacy accrual path having
      // written this (user, currency, night) before the cutover.
      await tx.insert(creditTransactions).values({
        userId: args.userId,
        type: 'interest',
        amountMinor: mintedMinor,
        currency,
        referenceType: null,
        referenceId: null,
        periodCursor: args.period,
      });
      await tx
        .insert(userCredits)
        .values({ userId: args.userId, currency, balanceMinor: mintedMinor })
        .onConflictDoUpdate({
          target: [userCredits.userId, userCredits.currency],
          set: {
            balanceMinor: sql`${userCredits.balanceMinor} + ${mintedMinor}`,
            updatedAt: sql`NOW()`,
          },
        });

      // On-chain half: enqueue the issuer-signed mint. The payout
      // worker selects the issuer keypair for `kind='interest_mint'`
      // rows (payout-worker-pay-one.ts) and drives submit/retry/
      // classify exactly like every other payout.
      await tx.insert(pendingPayouts).values({
        userId: args.userId,
        orderId: null,
        kind: 'interest_mint',
        assetCode: args.asset.code,
        assetIssuer: args.asset.issuer,
        toAddress: args.walletAddress,
        amountStroops: mintedMinor * STROOPS_PER_MINOR,
        memoText: generatePayoutMemo(),
      });

      return { outcome: 'minted' as const, mintedMinor };
    });
  } catch (err) {
    // Unique-violation on either fence = this (user, asset, night)
    // was already processed (crash-retry of a partially-completed
    // sweep, or a racing worker). Skip and keep going. AUDIT-2 finding
    // D: this used to match on the top-level `err.message`, which
    // never matches the real Drizzle-wrapped driver error (its
    // top-level message is the fixed "Failed query: ..." string, not
    // the constraint-violation text — that lives on `err.cause`). A
    // misclassified benign duplicate fell through to `throw err`,
    // which kept `writeMintCursor` from ever advancing for the rest
    // of the UTC day.
    if (isUniqueViolationOnAny(err, INTEREST_MINT_IDEMPOTENCY_CONSTRAINTS)) {
      return { outcome: 'skipped_already', mintedMinor: 0n };
    }
    throw err;
  }
}

export interface InterestMintTickResult {
  /** The UTC-day period this tick targeted. */
  period: string;
  /** True when another machine held the fleet-wide mint lock. */
  skippedLocked: boolean;
  /**
   * CON-04: true when the sweep exceeded `INTEREST_MINT_TICK_LEASE_MS`
   * and the fleet-wide lock was force-released mid-run. The cursor is
   * left unadvanced so the next tick re-runs the period (fences skip
   * anyone already minted).
   */
  leaseTimedOut: boolean;
  /** True when the cursor already covered the period (cheap no-op tick). */
  alreadyProcessed: boolean;
  /** Activated-wallet users considered. */
  eligibleUsers: number;
  /** (user, asset) pairs that produced a mint (ledger + payout rows). */
  minted: number;
  /** Pairs whose accrual stayed sub-minor — snapshot + carry only. */
  accruedOnly: number;
  /** Pairs with no balance in the asset this night. */
  skippedZeroBalance: number;
  /** Pairs already processed for this period (idempotency fences). */
  skippedAlready: number;
  /** Pairs whose drive threw (Horizon/DB) — retried next tick. */
  errors: number;
  /** Sum of minted minor units per currency. */
  totalsMinor: Record<string, bigint>;
}

let tickInFlight = false;

/**
 * Single pass. Safe to call repeatedly — the cursor fast-path and the
 * two per-user fences make every re-run idempotent per period.
 */
export async function runInterestMintTick(args?: {
  now?: Date;
  apyBps?: number;
  /** Test seam / override for the CON-04 lease (default `INTEREST_MINT_TICK_LEASE_MS`). */
  leaseMs?: number;
}): Promise<InterestMintTickResult> {
  const period = utcPeriodCursor(args?.now ?? new Date());
  const leaseMs = args?.leaseMs ?? INTEREST_MINT_TICK_LEASE_MS;

  // CON-04: race the locked sweep against a lease deadline so the
  // fleet-wide lock can never be held past `leaseMs`. On timeout the
  // race settles, `withAdvisoryLock` runs its `finally` and releases
  // the lock, and we return without advancing the cursor. The orphaned
  // sweep may keep running in the background (JS can't cancel it) — but
  // it only ever writes behind the per-user idempotency fences, so a
  // second machine acquiring the freed lock cannot double-mint. Mirrors
  // `runPayoutTick`.
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  const locked = await withAdvisoryLock(interestMintLockKey(), () =>
    Promise.race([
      runInterestMintTickLocked({ ...args, period }),
      new Promise<typeof TICK_LEASE_TIMED_OUT>((resolve) => {
        leaseTimer = setTimeout(() => resolve(TICK_LEASE_TIMED_OUT), leaseMs);
      }),
    ]),
  );
  if (leaseTimer !== undefined) clearTimeout(leaseTimer);

  if (!locked.ran) {
    return {
      period,
      skippedLocked: true,
      leaseTimedOut: false,
      alreadyProcessed: false,
      eligibleUsers: 0,
      minted: 0,
      accruedOnly: 0,
      skippedZeroBalance: 0,
      skippedAlready: 0,
      errors: 0,
      totalsMinor: {},
    };
  }
  if (locked.value === TICK_LEASE_TIMED_OUT) {
    log.error(
      { period, leaseMs },
      'Interest-mint sweep exceeded its lease deadline — releasing the fleet-wide lock so a hung leader cannot stall interest minting fleet-wide. The cursor is NOT advanced; the next tick re-runs this period and the per-user idempotency fences skip everyone already minted.',
    );
    return {
      period,
      skippedLocked: false,
      leaseTimedOut: true,
      alreadyProcessed: false,
      eligibleUsers: 0,
      minted: 0,
      accruedOnly: 0,
      skippedZeroBalance: 0,
      skippedAlready: 0,
      errors: 0,
      totalsMinor: {},
    };
  }
  return locked.value;
}

async function runInterestMintTickLocked(args: {
  now?: Date;
  apyBps?: number;
  period: string;
}): Promise<InterestMintTickResult> {
  const apyBps = args?.apyBps ?? env.INTEREST_APY_BASIS_POINTS;
  const period = args.period;
  const result: InterestMintTickResult = {
    period,
    skippedLocked: false,
    leaseTimedOut: false,
    alreadyProcessed: false,
    eligibleUsers: 0,
    minted: 0,
    accruedOnly: 0,
    skippedZeroBalance: 0,
    skippedAlready: 0,
    errors: 0,
    totalsMinor: {},
  };
  if (apyBps <= 0) return result;

  // Mintable assets: on the ONCHAIN_MINT_ELIGIBLE_ASSETS allowlist,
  // with a configured issuer ADDRESS and a validated issuer SIGNER.
  // Assets without a signer are skipped entirely — writing
  // ledger+payout rows the worker could never sign would strand the
  // mirror ahead of the chain. Assets off the allowlist are skipped
  // even with a fully configured signer — see the allowlist doc
  // comment for why (unbacked-mint prevention, ADR 031 v7).
  const signers = resolveIssuerSigners();
  const assets = configuredLoopPayableAssets().filter((a) => {
    if (!ONCHAIN_MINT_ELIGIBLE_ASSETS.has(a.code)) return false;
    const signer = signers.get(a.code);
    return signer !== undefined && signer.account === a.issuer;
  });
  if (assets.length === 0) return result;

  const cursor = await readMintCursor();
  if (cursor === period) {
    result.alreadyProcessed = true;
    return result;
  }
  if (cursor !== null && cursor < period) {
    // More than a day behind means at least one full UTC day passed
    // with no tick at all. Those nights are not retro-minted (no
    // balance snapshot exists for them) — surface loudly for ops.
    const gapDate = new Date(`${cursor}T00:00:00Z`);
    const daysBehind = Math.floor(
      ((args?.now ?? new Date()).getTime() - gapDate.getTime()) / 86_400_000,
    );
    if (daysBehind > 1) {
      log.warn(
        { cursor, period, daysBehind },
        'Interest-mint cursor is more than one period behind — fully-missed UTC days are not retro-minted; compensate via admin emission if required',
      );
    }
  }

  const eligible = await db
    .select({ id: users.id, walletAddress: users.walletAddress })
    .from(users)
    .where(and(eq(users.walletProvisioning, 'activated'), isNotNull(users.walletAddress)));
  result.eligibleUsers = eligible.length;

  for (const user of eligible) {
    if (user.walletAddress === null) continue; // narrowed by the query; for the type system
    for (const asset of assets) {
      try {
        const r = await mintOneUser({
          userId: user.id,
          walletAddress: user.walletAddress,
          asset,
          period,
          apyBps,
        });
        switch (r.outcome) {
          case 'minted': {
            result.minted++;
            const currency = fiatOf(asset.code);
            const prev = result.totalsMinor[currency];
            result.totalsMinor[currency] = (prev ?? 0n) + r.mintedMinor;
            break;
          }
          case 'accrued_only':
            result.accruedOnly++;
            break;
          case 'skipped_zero_balance':
            result.skippedZeroBalance++;
            break;
          case 'skipped_already':
            result.skippedAlready++;
            break;
        }
      } catch (err) {
        result.errors++;
        log.error(
          { err, userId: user.id, assetCode: asset.code, period },
          'Interest mint failed for user — will retry on the next tick of this period',
        );
      }
    }
  }

  // Advance the cursor only when the sweep completed with no errors;
  // otherwise the next tick re-runs the period and the per-user
  // fences skip everyone that already landed.
  if (result.errors === 0) {
    await writeMintCursor(period);
  }
  return result;
}

// ─── Interval loop ──────────────────────────────────────────────────────────

let mintTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Fires one guarded tick. Exported for tests and for the first-tick
 * kick in `startInterestMintWorker`.
 */
export async function tickInterestMint(args?: { apyBps?: number }): Promise<void> {
  if (tickInFlight) {
    log.warn('Interest-mint tick skipped — prior tick still running');
    return;
  }
  tickInFlight = true;
  try {
    const r = await runInterestMintTick(args);
    if (!r.alreadyProcessed) {
      log.info(
        {
          period: r.period,
          eligibleUsers: r.eligibleUsers,
          minted: r.minted,
          accruedOnly: r.accruedOnly,
          skippedZeroBalance: r.skippedZeroBalance,
          skippedAlready: r.skippedAlready,
          errors: r.errors,
          totalsMinor: Object.fromEntries(
            Object.entries(r.totalsMinor).map(([c, v]) => [c, v.toString()]),
          ),
        },
        'Interest-mint tick complete',
      );
    }
    markWorkerTickSuccess('interest_mint');
  } catch (err) {
    markWorkerTickFailure('interest_mint', err);
    log.error({ err }, 'Interest-mint tick failed');
  } finally {
    tickInFlight = false;
  }
}

/**
 * Starts the periodic interest-mint worker. Gated at the caller
 * (`index.ts`) by `LOOP_WORKERS_ENABLED` + `LOOP_INTEREST_ONCHAIN_ENABLED`
 * + a non-zero APY + at least one issuer signer.
 */
export function startInterestMintWorker(args?: { apyBps?: number; intervalMs?: number }): void {
  stopInterestMintWorker();
  const intervalMs = args?.intervalMs ?? INTEREST_MINT_TICK_INTERVAL_MS;
  markWorkerStarted('interest_mint', { staleAfterMs: Math.max(intervalMs * 3, 60_000) });
  log.info(
    { intervalMs, apyBps: args?.apyBps ?? env.INTEREST_APY_BASIS_POINTS },
    'Starting interest-mint worker (on-chain nightly interest, ADR 031)',
  );
  setImmediate(() => {
    void tickInterestMint(args?.apyBps !== undefined ? { apyBps: args.apyBps } : undefined);
  });
  mintTimer = setInterval(() => {
    void tickInterestMint(args?.apyBps !== undefined ? { apyBps: args.apyBps } : undefined);
  }, intervalMs);
  mintTimer.unref();
}

export function stopInterestMintWorker(): void {
  if (mintTimer !== null) {
    clearInterval(mintTimer);
    mintTimer = null;
  }
  markWorkerStopped('interest_mint');
}
