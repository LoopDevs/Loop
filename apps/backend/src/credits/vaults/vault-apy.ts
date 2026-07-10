/**
 * Vault + GBPLOOP APY computation (ADR 031 §Detailed design D8 /
 * §User-facing display, V5b). Pure read + math — no Soroban call, no
 * DB write. Backs `GET /api/me/vault-apy`
 * (`users/vault-apy-handler.ts`).
 *
 * ── LOOPUSD / LOOPEUR (vault shares) ─────────────────────────────────
 * `APY = (sharePrice(now) / sharePrice(30d_ago)) ^ (365/actualDays) − 1`
 * from `vault_share_price_snapshots` (written by
 * `credits/vaults/vault-apy-snapshot.ts`'s cron — this module never
 * hits Soroban itself). "30d ago" is the NEAREST snapshot at least 30
 * days older than the latest one, per ADR 031 §D8; `actualDays` (not a
 * hardcoded 30) is used in the exponent so a slightly-off cadence
 * (snapshot landed 31 days ago, say, because a tick was skipped)
 * doesn't silently mis-annualise. The past-90-day range is the
 * min/max of that SAME rolling-30-day APY computed at every snapshot
 * point within the last 90 days that itself has a valid ≥30-day-old
 * reference — matching the ADR's "Range over past 90 days: 2.8% –
 * 3.5%" display language (the spread of the realised 30-day rate over
 * the quarter, not a single-day instantaneous rate).
 *
 * ── GBPLOOP (classic 1:1 asset, nightly mints) ──────────────────────
 * Realised from `interest_mint_snapshots` — the SAME table
 * `credits/interest-mint.ts` already writes one row into per
 * (user, night). Rather than reading the currently-configured
 * `INTEREST_APY_BASIS_POINTS` back out (which would just echo config,
 * not "realised" history — and would drift from what was actually
 * paid across a mid-window rate change), this aggregates the accrual
 * ACTUALLY minted against the balance it was minted against:
 * `dailyRate = Σaccrual / Σbalance` over the relevant window (the
 * balance-weighted average of each night's `accrual/balance` — exact
 * because `accrual_i = balance_i × rate_i` by construction, so
 * `Σaccrual / Σbalance = Σ(balance_i × rate_i) / Σbalance_i`, the
 * balance-weighted mean rate). Compounded to an annual figure the same
 * way the vault side is: `(1 + dailyRate) ^ 365 − 1`.
 *
 * ── Insufficient-history rule (shared by both assets) ───────────────
 * Fewer than two data points, or the oldest available data point isn't
 * at least `MIN_HISTORY_DAYS` old yet → both `past30dApy` and
 * `past90dRange` are `null`. Never a fabricated, zero, or
 * divide-by-zero figure.
 *
 * ── No yield-source disclosure (ADR 031 §User-facing display) ───────
 * Every value this module returns is a plain number or `null`. No
 * string here or in any caller may name the mechanism (DeFindex /
 * Blend / Soroban / "vault" / "strategy") — the whole point of this
 * computation is to reduce the mechanism to an APY figure.
 */
import { and, eq, gte } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { interestMintSnapshots } from '../../db/schema.js';
import { env } from '../../env.js';
import { MAINNET_NETWORK_PASSPHRASE } from '../../env/schema-helpers.js';
import { vaultsEnabled, listActiveVaults, listSharePriceSnapshotsSince } from './registry.js';
import type { LoopVaultAssetCode, LoopVaultNetwork } from '../../db/schema.js';

const DAY_MS = 86_400_000;

/**
 * Derives the live network the same way every other vault module does
 * (deliberately duplicated per module — see `vault-drift-watcher.ts`'s
 * identical helper). Exported here (unlike the cron's private copy)
 * because `users/vault-apy-handler.ts` needs it too and this module is
 * already the shared "vault APY business logic" layer for both.
 */
export function currentVaultNetwork(): LoopVaultNetwork {
  return env.LOOP_STELLAR_NETWORK_PASSPHRASE === MAINNET_NETWORK_PASSPHRASE ? 'mainnet' : 'testnet';
}

/** Minimum age (days) the oldest available data point must have before an APY is computed at all (ADR 031 §D8). */
const MIN_HISTORY_DAYS = 30;

/** Width of the displayed min/max range window (ADR 031 §User-facing display). */
const RANGE_WINDOW_DAYS = 90;

/** How far back the vault snapshot series is fetched — the range window plus enough slack that the earliest in-range anchor still has a valid ≥30-day-old reference. */
const VAULT_FETCH_WINDOW_DAYS = RANGE_WINDOW_DAYS + MIN_HISTORY_DAYS;

export interface AssetApyResult {
  past30dApy: number | null;
  past90dRange: { minApy: number; maxApy: number } | null;
}

/** `YYYY-MM-DD` UTC calendar day — deliberately duplicated per-module, see `vault-apy-snapshot.ts`. */
function utcDayKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / DAY_MS;
}

/**
 * Compounds a growth ratio observed over `daysBetween` days into an
 * annualised (365-day) rate. `null` on any non-finite / non-positive
 * input rather than throwing — callers already gate on having valid
 * data; this is the last defensive line before a NaN/Infinity would
 * otherwise leak into a user-facing number.
 */
export function annualizeRatio(ratio: number, daysBetweenSamples: number): number | null {
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  if (!Number.isFinite(daysBetweenSamples) || daysBetweenSamples <= 0) return null;
  const apy = Math.pow(ratio, 365 / daysBetweenSamples) - 1;
  return Number.isFinite(apy) ? apy : null;
}

interface SharePriceSample {
  takenAt: Date;
  sharePricePpm: bigint;
}

/**
 * The nearest sample in `ascending` that is at least `minDaysAgo` days
 * older than `anchor` — i.e. the LATEST sample at or before
 * `anchor.takenAt - minDaysAgo days`. `null` when no sample is old
 * enough yet. `ascending` must be sorted oldest-first.
 */
function findReference(
  ascending: SharePriceSample[],
  anchor: SharePriceSample,
  minDaysAgo: number,
): SharePriceSample | null {
  const cutoffMs = anchor.takenAt.getTime() - minDaysAgo * DAY_MS;
  let best: SharePriceSample | null = null;
  for (const sample of ascending) {
    if (sample.takenAt.getTime() <= cutoffMs) {
      best = sample;
    } else {
      break;
    }
  }
  return best;
}

/**
 * Pure function over an ascending share-price series (ADR 031 §D8).
 * Exported for direct unit testing against known-value fixtures
 * without touching the DB.
 */
export function computeApyFromSharePriceSeries(ascending: SharePriceSample[]): AssetApyResult {
  if (ascending.length < 2) return { past30dApy: null, past90dRange: null };
  const latest = ascending[ascending.length - 1]!;

  const ref30 = findReference(ascending, latest, MIN_HISTORY_DAYS);
  const past30dApy =
    ref30 === null
      ? null
      : annualizeRatio(
          Number(latest.sharePricePpm) / Number(ref30.sharePricePpm),
          daysBetween(ref30.takenAt, latest.takenAt),
        );

  const rangeCutoffMs = latest.takenAt.getTime() - RANGE_WINDOW_DAYS * DAY_MS;
  const apysInRange: number[] = [];
  for (const anchor of ascending) {
    if (anchor.takenAt.getTime() < rangeCutoffMs) continue;
    const ref = findReference(ascending, anchor, MIN_HISTORY_DAYS);
    if (ref === null) continue;
    const apy = annualizeRatio(
      Number(anchor.sharePricePpm) / Number(ref.sharePricePpm),
      daysBetween(ref.takenAt, anchor.takenAt),
    );
    if (apy !== null) apysInRange.push(apy);
  }
  const past90dRange =
    apysInRange.length === 0
      ? null
      : { minApy: Math.min(...apysInRange), maxApy: Math.max(...apysInRange) };

  return { past30dApy, past90dRange };
}

/**
 * `computeApyFromSharePriceSeries` fed from `vault_share_price_snapshots`
 * for one active vault. `null`/`null` (never a fabricated number) when
 * the vault subsystem is disabled or there isn't enough history yet.
 */
export async function computeVaultApy(
  assetCode: LoopVaultAssetCode,
  network: LoopVaultNetwork,
): Promise<AssetApyResult> {
  if (!vaultsEnabled()) return { past30dApy: null, past90dRange: null };
  const since = new Date(Date.now() - VAULT_FETCH_WINDOW_DAYS * DAY_MS);
  const rows = await listSharePriceSnapshotsSince(assetCode, network, since);
  return computeApyFromSharePriceSeries(
    rows.map((r) => ({ takenAt: r.takenAt, sharePricePpm: r.sharePricePpm })),
  );
}

/**
 * The active LOOPUSD/LOOPEUR vaults on the live network, each paired
 * with its computed APY. Empty when the vault subsystem is disabled
 * (`listActiveVaults` already gates on `vaultsEnabled()`) — the
 * "returns empty when vaults disabled" behaviour the read endpoint
 * needs.
 */
export async function listVaultApyAssets(): Promise<
  Array<{ assetCode: LoopVaultAssetCode; network: LoopVaultNetwork; apy: AssetApyResult }>
> {
  const network = currentVaultNetwork();
  const vaults = await listActiveVaults(network);
  const out: Array<{
    assetCode: LoopVaultAssetCode;
    network: LoopVaultNetwork;
    apy: AssetApyResult;
  }> = [];
  for (const vault of vaults) {
    const assetCode = vault.assetCode as LoopVaultAssetCode;
    const vaultNetwork = vault.network as LoopVaultNetwork;
    const apy = await computeVaultApy(assetCode, vaultNetwork);
    out.push({ assetCode, network: vaultNetwork, apy });
  }
  return out;
}

interface DailyAccrualBucket {
  balanceStroops: bigint;
  accrualStroops: bigint;
}

/**
 * Pure function over a day-bucketed accrual/balance series (one bucket
 * per UTC calendar day, summed across every user's snapshot rows that
 * night). Exported for direct unit testing.
 */
export function computeGbploopApyFromBuckets(
  bucketsByDay: Map<string, DailyAccrualBucket>,
  now: Date,
): AssetApyResult {
  if (bucketsByDay.size < 2) return { past30dApy: null, past90dRange: null };

  let earliestMs = Infinity;
  for (const key of bucketsByDay.keys()) {
    const ms = Date.parse(`${key}T00:00:00.000Z`);
    if (ms < earliestMs) earliestMs = ms;
  }
  if (!Number.isFinite(earliestMs) || daysBetween(new Date(earliestMs), now) < MIN_HISTORY_DAYS) {
    return { past30dApy: null, past90dRange: null };
  }

  const thirtyDayCutoffMs = now.getTime() - MIN_HISTORY_DAYS * DAY_MS;
  const rangeCutoffMs = now.getTime() - RANGE_WINDOW_DAYS * DAY_MS;

  let sumBalance30 = 0n;
  let sumAccrual30 = 0n;
  const apysInRange: number[] = [];

  for (const [key, bucket] of bucketsByDay) {
    if (bucket.balanceStroops <= 0n) continue;
    const dayMs = Date.parse(`${key}T00:00:00.000Z`);
    const dailyRate = Number(bucket.accrualStroops) / Number(bucket.balanceStroops);

    if (dayMs >= thirtyDayCutoffMs) {
      sumBalance30 += bucket.balanceStroops;
      sumAccrual30 += bucket.accrualStroops;
    }
    if (dayMs >= rangeCutoffMs) {
      const apy = annualizeRatio(1 + dailyRate, 1);
      if (apy !== null) apysInRange.push(apy);
    }
  }

  const past30dApy =
    sumBalance30 > 0n ? annualizeRatio(1 + Number(sumAccrual30) / Number(sumBalance30), 1) : null;
  const past90dRange =
    apysInRange.length === 0
      ? null
      : { minApy: Math.min(...apysInRange), maxApy: Math.max(...apysInRange) };

  return { past30dApy, past90dRange };
}

/**
 * Reads `interest_mint_snapshots` for GBPLOOP over the past
 * `RANGE_WINDOW_DAYS` and computes the realised APY. Callers decide
 * WHETHER to call this (the on-chain-mint-eligibility check —
 * `LOOP_INTEREST_ONCHAIN_ENABLED` + a configured GBPLOOP issuer —
 * mirrors `users/wallet-handler.ts`'s `interestApyBps` truthfulness
 * gate and lives in the handler, not here, so both surfaces share one
 * definition of "is this deployment actually paying GBPLOOP interest
 * right now").
 */
export async function computeGbploopApy(now: Date = new Date()): Promise<AssetApyResult> {
  const windowStart = new Date(now.getTime() - RANGE_WINDOW_DAYS * DAY_MS);
  const rows = await db
    .select({
      createdAt: interestMintSnapshots.createdAt,
      balanceStroops: interestMintSnapshots.balanceStroops,
      accrualStroops: interestMintSnapshots.accrualStroops,
    })
    .from(interestMintSnapshots)
    .where(
      and(
        eq(interestMintSnapshots.assetCode, 'GBPLOOP'),
        gte(interestMintSnapshots.createdAt, windowStart),
      ),
    );

  const bucketsByDay = new Map<string, DailyAccrualBucket>();
  for (const row of rows) {
    const key = utcDayKey(row.createdAt);
    const bucket = bucketsByDay.get(key) ?? { balanceStroops: 0n, accrualStroops: 0n };
    bucket.balanceStroops += row.balanceStroops;
    bucket.accrualStroops += row.accrualStroops;
    bucketsByDay.set(key, bucket);
  }

  return computeGbploopApyFromBuckets(bucketsByDay, now);
}
