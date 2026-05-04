/**
 * Interest forward-mint pool watcher (ADR 009 / 015).
 *
 * Periodic check that the on-chain pool balance can cover the next
 * N days of forecast daily interest at the current APY. When cover
 * drops below `LOOP_INTEREST_POOL_MIN_DAYS_COVER`, fires a Discord
 * page so the operator mints the next batch before users would be
 * under-allocated.
 *
 * Sibling to:
 *   - `asset-drift-watcher.ts` — pool-aware reconciliation (the
 *     pool subtracted from on-chain when computing drift).
 *   - `accrue-interest.ts` / `interest-scheduler.ts` — daily
 *     off-chain credit writes that drain the pool conceptually.
 *   - `interest-forecast.ts` — pure helper this watcher reads to
 *     compute "days of cover."
 *
 * Design choices:
 *   - **One-shot dedup per asset.** First page when an asset goes
 *     low; recovery page when it comes back. Same pattern as
 *     `notifyAssetDrift` / `notifyAssetDriftRecovered` so the
 *     channel has paired open + close events.
 *   - **Stateless math.** Daily interest forecast is computed on
 *     the fly from the current cohort balance + APY; no need to
 *     persist anything between ticks.
 *   - **Skip silently when pool isn't configured.** A deployment
 *     without the operator secret has nothing to forecast against;
 *     no value pinging the channel about it.
 */
import { computeInterestForecast } from '../credits/interest-forecast.js';
import { resolveInterestPoolAccount } from '../credits/interest-pool.js';
import { configuredLoopPayableAssets, type LoopAssetCode } from '../credits/payout-asset.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { notifyInterestPoolLow, notifyInterestPoolRecovered } from '../discord.js';
import { getAssetBalance } from './horizon-asset-balance.js';

const log = logger.child({ area: 'interest-pool-watcher' });

/** 1e5 stroops per minor unit — LOOP-asset 7-decimal layout. */
const STROOPS_PER_MINOR = 100_000n;

export interface PoolCoverageSample {
  assetCode: LoopAssetCode;
  poolStroops: bigint;
  /** Forecast daily interest expressed in LOOP-asset stroops. */
  dailyInterestStroops: bigint;
  /** `poolStroops / dailyInterestStroops`, or +Infinity when daily=0n. */
  daysOfCover: number;
  belowThreshold: boolean;
  notified: boolean;
}

export interface PoolWatcherTickResult {
  checked: number;
  skipped: number;
  samples: PoolCoverageSample[];
}

/**
 * Single tick of the pool-coverage check. Called by the scheduler
 * (not exported as a separate worker entry).
 */
export async function runInterestPoolWatcherTick(args: {
  apyBasisPoints: number;
  minDaysOfCover: number;
}): Promise<PoolWatcherTickResult> {
  const result: PoolWatcherTickResult = { checked: 0, skipped: 0, samples: [] };
  if (args.apyBasisPoints <= 0) return result;

  const poolAccount = resolveInterestPoolAccount();
  if (poolAccount === null) {
    log.debug('Interest pool watcher: no pool account configured, skipping');
    return result;
  }

  const assets = configuredLoopPayableAssets();
  if (assets.length === 0) return result;

  const forecast = await computeInterestForecast({
    apyBasisPoints: args.apyBasisPoints,
    forecastDays: 1,
  });
  const perCurrencyDaily = new Map<LoopAssetCode, bigint>();
  for (const entry of forecast.perCurrency) {
    perCurrencyDaily.set(entry.assetCode, entry.dailyInterestMinor);
  }

  for (const { code, issuer } of assets) {
    let poolStroops: bigint;
    try {
      const balance = await getAssetBalance(poolAccount, code, issuer);
      poolStroops = balance ?? 0n;
    } catch (err) {
      log.warn({ err, assetCode: code }, 'Pool-balance read failed; skipping cover check');
      result.skipped++;
      continue;
    }
    result.checked++;
    const dailyMinor = perCurrencyDaily.get(code) ?? 0n;
    const dailyInterestStroops = dailyMinor * STROOPS_PER_MINOR;
    const daysOfCover =
      dailyInterestStroops === 0n
        ? Number.POSITIVE_INFINITY
        : Number(poolStroops) / Number(dailyInterestStroops);
    const belowThreshold = dailyInterestStroops > 0n && daysOfCover < args.minDaysOfCover;

    const sample: PoolCoverageSample = {
      assetCode: code,
      poolStroops,
      dailyInterestStroops,
      daysOfCover,
      belowThreshold,
      notified: false,
    };

    if (belowThreshold) {
      notifyInterestPoolLow({
        assetCode: code,
        poolStroops: poolStroops.toString(),
        dailyInterestStroops: dailyInterestStroops.toString(),
        daysOfCover,
        minDaysOfCover: args.minDaysOfCover,
      });
      sample.notified = true;
    } else if (dailyInterestStroops > 0n) {
      // Recovery: only fires if the asset was previously low —
      // notifyInterestPoolRecovered's dedup set short-circuits when
      // the asset hadn't paged. So this is safe to call unconditionally
      // on every above-threshold sample.
      notifyInterestPoolRecovered({
        assetCode: code,
        poolStroops: poolStroops.toString(),
        daysOfCover,
      });
    }
    result.samples.push(sample);
  }
  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Schedules `runInterestPoolWatcherTick` on a fixed interval. Caller
 * gates on `LOOP_WORKERS_ENABLED` + `INTEREST_APY_BASIS_POINTS > 0`.
 * Idempotent — calling twice clears the prior interval.
 */
export function startInterestPoolWatcher(args: {
  apyBasisPoints: number;
  minDaysOfCover: number;
  intervalMs: number;
}): void {
  stopInterestPoolWatcher();
  log.info(
    {
      minDaysOfCover: args.minDaysOfCover,
      intervalMs: args.intervalMs,
      apyBasisPoints: args.apyBasisPoints,
    },
    'Interest pool watcher starting',
  );
  const tick = async (): Promise<void> => {
    try {
      const r = await runInterestPoolWatcherTick({
        apyBasisPoints: args.apyBasisPoints,
        minDaysOfCover: args.minDaysOfCover,
      });
      if (r.samples.some((s) => s.notified) || r.skipped > 0) {
        log.info(
          {
            checked: r.checked,
            skipped: r.skipped,
            below: r.samples.filter((s) => s.belowThreshold).map((s) => s.assetCode),
          },
          'Interest pool watcher tick complete',
        );
      }
    } catch (err) {
      log.error({ err }, 'Interest pool watcher tick failed');
    }
  };
  void tick();
  timer = setInterval(() => void tick(), args.intervalMs);
  timer.unref();
}

export function stopInterestPoolWatcher(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

/** Operator-tunable defaults exposed to env / boot wiring. */
export const INTEREST_POOL_WATCHER_DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1h
export const INTEREST_POOL_WATCHER_DEFAULT_MIN_DAYS = 7;

/** Resolves the watcher's days-of-cover threshold from env. */
export function resolvePoolMinDaysCover(): number {
  const v = env.LOOP_INTEREST_POOL_MIN_DAYS_COVER;
  return typeof v === 'number' && v > 0 ? v : INTEREST_POOL_WATCHER_DEFAULT_MIN_DAYS;
}
