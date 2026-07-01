/**
 * Admin interest forward-mint forecast (ADR 009 / 015).
 *
 * `GET /api/admin/interest/mint-forecast` — surfaces, for each
 * configured LOOP asset, the inputs an operator needs to top up the
 * interest forward-mint pool:
 *
 *   - current cohort balance + APY → daily / forecast-period interest
 *   - current pool balance (read from Horizon)
 *   - days of cover at the current run-rate
 *   - recommended next-mint amount (forecast − pool, floored at 0)
 *
 * Operator workflow:
 *   1. Hit this endpoint (admin UI or curl).
 *   2. Take the per-currency `recommendedMintStroops` and submit a
 *      Stellar payment from the issuer account to the pool account
 *      for that amount, signed with the cold-stored issuer secret.
 *      Loop's backend never holds the issuer secret — minting is a
 *      deliberate manual step (ADR 015).
 *   3. The drift watcher next tick observes the new pool balance,
 *      reconciliation stays clean (pool-aware drift = 0), depletion
 *      alert closes via `notifyInterestPoolRecovered`.
 *
 * Pure read endpoint — Cache-Control: private, no-store mounted at
 * the route level via `privateNoStoreResponse`.
 */
import type { Context } from 'hono';
import { env } from '../env.js';
import { computeInterestForecast } from '../credits/interest-forecast.js';
import { resolveInterestPoolAccount } from '../credits/interest-pool.js';
import { configuredLoopPayableAssets, type LoopAssetCode } from '../credits/payout-asset.js';
import { getAssetBalance } from '../payments/horizon-asset-balance.js';
import { resolvePoolMinDaysCover } from '../payments/interest-pool-watcher.js';
import { logger } from '../logger.js';
import type { HomeCurrency } from '@loop/shared';

const log = logger.child({ handler: 'admin-interest-mint-forecast' });

const STROOPS_PER_MINOR = 100_000n;

export interface InterestMintForecastRow {
  assetCode: LoopAssetCode;
  currency: HomeCurrency;
  /** Sum of `user_credits.balance_minor` for this currency (off-chain liability). */
  cohortBalanceMinor: string;
  /** Daily forecast interest for the cohort, in stroops. */
  dailyInterestStroops: string;
  /** `dailyInterestStroops × forecastDays`. */
  forecastDays: number;
  forecastInterestStroops: string;
  /** Pool balance at the configured pool account, in stroops. */
  poolStroops: string;
  /** Days of cover at current run-rate. `null` when daily interest is 0. */
  daysOfCover: number | null;
  /** Operator alert threshold — values below this trip the depletion alert. */
  minDaysOfCover: number;
  /** Suggested next-mint amount in stroops: max(0, forecast − pool). */
  recommendedMintStroops: string;
}

export interface InterestMintForecastResponse {
  apyBasisPoints: number;
  forecastDays: number;
  poolAccount: string | null;
  asOfMs: number;
  /**
   * Null when interest is feature-off (`INTEREST_APY_BASIS_POINTS=0`)
   * — clients render "interest not enabled" from this rather than
   * showing zero-coverage rows that imply imminent ops action.
   */
  rows: InterestMintForecastRow[] | null;
}

export async function adminInterestMintForecastHandler(c: Context): Promise<Response> {
  const apy = env.INTEREST_APY_BASIS_POINTS;
  const poolAccount = resolveInterestPoolAccount();
  const minDaysOfCover = resolvePoolMinDaysCover();

  const forecastDaysRaw = c.req.query('forecastDays');
  const parsedDays = forecastDaysRaw !== undefined ? Number.parseInt(forecastDaysRaw, 10) : 35;
  const forecastDays =
    Number.isFinite(parsedDays) && parsedDays > 0 && parsedDays <= 365 ? parsedDays : 35;

  const body: InterestMintForecastResponse = {
    apyBasisPoints: apy,
    forecastDays,
    poolAccount,
    asOfMs: Date.now(),
    rows: null,
  };

  if (apy <= 0) {
    return c.json(body);
  }

  // PLAT-30-17: the DB-side forecast computation had no try/catch at
  // all, relying entirely on the global onError fallback — inconsistent
  // with the request-scoped INTERNAL_ERROR shape every sibling admin
  // read handler returns, and undeclared in the openapi spec.
  let forecast: Awaited<ReturnType<typeof computeInterestForecast>>;
  try {
    forecast = await computeInterestForecast({
      apyBasisPoints: apy,
      forecastDays,
    });
  } catch (err) {
    log.error({ err }, 'Interest forecast computation failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to compute interest forecast' }, 500);
  }

  const assets = configuredLoopPayableAssets();
  const issuerByCode = new Map<LoopAssetCode, string>();
  for (const a of assets) issuerByCode.set(a.code, a.issuer);

  const rows: InterestMintForecastRow[] = [];
  for (const entry of forecast.perCurrency) {
    const issuer = issuerByCode.get(entry.assetCode);
    let poolStroops = 0n;
    if (issuer !== undefined && poolAccount !== null) {
      try {
        const balance = await getAssetBalance(poolAccount, entry.assetCode, issuer);
        poolStroops = balance ?? 0n;
      } catch (err) {
        // PLAT-30-17 (2026-06-30 cold audit): a swallowed Horizon
        // failure here used to fall through with poolStroops=0n,
        // fabricating a near-empty pool balance instead of the
        // documented 503. That's the exact failure class this tool
        // exists to prevent against — an operator reading this
        // forecast during a transient Horizon outage would see a
        // fake zero-cover row and could over-mint LOOP-asset into a
        // pool that already has ample real balance. Bail the whole
        // request loudly instead, matching admin-asset-circulation.ts's
        // established pattern for the same failure class.
        log.error(
          { err, assetCode: entry.assetCode, poolAccount },
          'Pool-balance read failed — bailing the forecast request rather than fabricating poolStroops=0',
        );
        return c.json(
          {
            code: 'UPSTREAM_UNAVAILABLE',
            message: `On-chain pool-balance read failed for ${entry.assetCode}`,
          },
          503,
        );
      }
    }

    const dailyInterestStroops = entry.dailyInterestMinor * STROOPS_PER_MINOR;
    const forecastInterestStroops = entry.forecastInterestMinor * STROOPS_PER_MINOR;
    const daysOfCover =
      dailyInterestStroops === 0n ? null : Number(poolStroops) / Number(dailyInterestStroops);
    const recommendedMintStroops =
      forecastInterestStroops > poolStroops ? forecastInterestStroops - poolStroops : 0n;

    rows.push({
      assetCode: entry.assetCode,
      currency: entry.currency,
      cohortBalanceMinor: entry.cohortBalanceMinor.toString(),
      dailyInterestStroops: dailyInterestStroops.toString(),
      forecastDays,
      forecastInterestStroops: forecastInterestStroops.toString(),
      poolStroops: poolStroops.toString(),
      daysOfCover,
      minDaysOfCover,
      recommendedMintStroops: recommendedMintStroops.toString(),
    });
  }
  body.rows = rows;

  return c.json(body);
}
