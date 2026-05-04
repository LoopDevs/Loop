import { serve } from '@hono/node-server';
import { flush as sentryFlush } from '@sentry/hono/node';
import { env } from './env.js';
import { logger } from './logger.js';
import { app, stopCleanupInterval } from './app.js';
import { startLocationRefresh, stopLocationRefresh } from './clustering/data-store.js';
import { startMerchantRefresh, stopMerchantRefresh } from './merchants/sync.js';
import { runMigrations, closeDb } from './db/client.js';
import { startPaymentWatcher, stopPaymentWatcher } from './payments/watcher.js';
import { startProcurementWorker, stopProcurementWorker } from './orders/procurement.js';
import {
  startPayoutWorker,
  stopPayoutWorker,
  resolvePayoutConfig,
} from './payments/payout-worker.js';
import { startAssetDriftWatcher, stopAssetDriftWatcher } from './payments/asset-drift-watcher.js';
import {
  startInterestPoolWatcher,
  stopInterestPoolWatcher,
  INTEREST_POOL_WATCHER_DEFAULT_INTERVAL_MS,
  resolvePoolMinDaysCover,
} from './payments/interest-pool-watcher.js';
import { configuredLoopPayableAssets } from './credits/payout-asset.js';
import { startInterestScheduler, stopInterestScheduler } from './credits/interest-scheduler.js';
import { markWorkerBlocked, markWorkerDisabled } from './runtime-health.js';

// A4-093: production gate for loop-native auth. The OTP send path
// requires a real email provider; today only the `console` provider
// exists (logs OTPs to stdout — refused in production by getEmailProvider).
// If an operator flips LOOP_AUTH_NATIVE_ENABLED=true in production
// without setting EMAIL_PROVIDER to a real provider, every OTP request
// will land in the catch arm and return 200 (per A4-002) without
// ever sending a code. Refuse to boot so the gap is loud rather than
// a silent live-traffic outage.
//
// Note: `EMAIL_PROVIDER=console` is already refused by getEmailProvider
// in production. This gate catches the upstream config error: no
// EMAIL_PROVIDER set at all + LOOP_AUTH_NATIVE_ENABLED=true.
if (
  env.NODE_ENV === 'production' &&
  env.LOOP_AUTH_NATIVE_ENABLED &&
  (process.env['EMAIL_PROVIDER'] === undefined || process.env['EMAIL_PROVIDER'] === 'console')
) {
  logger.error(
    'LOOP_AUTH_NATIVE_ENABLED=true in production but EMAIL_PROVIDER is unset / console — no real provider implemented; OTP requests will fail silently. Refusing to boot.',
  );
  process.exit(1);
}

// Apply any pending DB migrations before accepting traffic (ADR 012).
// Awaited so `serve()` below only runs after the schema is up-to-date —
// a partial-migration run-time is worse than a slightly-later boot.
// Skipped under NODE_ENV=test: the mocked e2e runner boots the backend
// with a placeholder DATABASE_URL and no live Postgres, and the admin
// endpoints that read/write the db are not exercised by that suite.
if (env.NODE_ENV !== 'test') {
  await runMigrations();
}

// Merchants load first (startMerchantRefresh triggers initial refresh).
// Locations start after a short delay to ensure merchant data is available
// for cross-referencing pin logos.
startMerchantRefresh();
const locationStartTimer = setTimeout(() => {
  startLocationRefresh();
}, 3000);

// Loop-native order workers (ADR 010). Gated behind LOOP_WORKERS_ENABLED
// so a fresh checkout doesn't start hammering Horizon / CTX before an
// operator has configured the Stellar deposit address + operator pool.
// Missing LOOP_STELLAR_DEPOSIT_ADDRESS with the flag on is a config
// error — log loudly but don't crash, so operators can still hit /health.
if (env.LOOP_WORKERS_ENABLED) {
  if (env.LOOP_STELLAR_DEPOSIT_ADDRESS === undefined) {
    markWorkerBlocked('payment_watcher', {
      reason: 'LOOP_STELLAR_DEPOSIT_ADDRESS is unset',
      staleAfterMs: env.LOOP_PAYMENT_WATCHER_INTERVAL_SECONDS * 3000,
    });
    logger.error(
      'LOOP_WORKERS_ENABLED=true but LOOP_STELLAR_DEPOSIT_ADDRESS is unset — payment watcher will not start',
    );
  } else {
    startPaymentWatcher({
      account: env.LOOP_STELLAR_DEPOSIT_ADDRESS,
      ...(env.LOOP_STELLAR_USDC_ISSUER !== undefined
        ? { usdcIssuer: env.LOOP_STELLAR_USDC_ISSUER }
        : {}),
      intervalMs: env.LOOP_PAYMENT_WATCHER_INTERVAL_SECONDS * 1000,
    });
  }
  startProcurementWorker({
    intervalMs: env.LOOP_PROCUREMENT_INTERVAL_SECONDS * 1000,
  });
  // Payout worker (ADR 016). Resolve reads LOOP_STELLAR_OPERATOR_SECRET
  // + network passphrase; returns null when the secret is unset, in
  // which case pending_payouts rows stay pending until ops plumbs it.
  const payoutConfig = resolvePayoutConfig();
  if (payoutConfig === null) {
    markWorkerBlocked('payout_worker', {
      reason: 'LOOP_STELLAR_OPERATOR_SECRET is unset',
      staleAfterMs: env.LOOP_PAYOUT_WORKER_INTERVAL_SECONDS * 3000,
    });
    logger.warn(
      'LOOP_WORKERS_ENABLED=true but LOOP_STELLAR_OPERATOR_SECRET is unset — payout worker will not start; pending_payouts rows will queue until configured',
    );
  } else {
    startPayoutWorker(payoutConfig);
  }

  // Asset-drift watcher (ADR 015). Silently skips when no LOOP
  // issuers are configured — the watcher has nothing to read
  // against. One issuer is enough (e.g. USD-only deployments).
  //
  // A4-064: emit a boot-time warning for PARTIAL issuer config
  // (one or two configured, the rest unset). Off-chain liability
  // accrues for unsupported currencies via cashback writes that
  // would otherwise route through the unconfigured asset, with
  // no telemetry. The watcher only sees configured assets, so
  // the unconfigured ones drift silently.
  const configured = configuredLoopPayableAssets();
  const ALL_LOOP_ASSETS: ReadonlyArray<'USDLOOP' | 'GBPLOOP' | 'EURLOOP'> = [
    'USDLOOP',
    'GBPLOOP',
    'EURLOOP',
  ];
  const configuredCodes = new Set(configured.map((a) => a.code));
  const missing = ALL_LOOP_ASSETS.filter((c) => !configuredCodes.has(c));
  if (configured.length > 0) {
    if (missing.length > 0) {
      logger.warn(
        { configured: [...configuredCodes], missing },
        'Partial LOOP-asset issuer config — drift watcher only covers configured currencies; off-chain liability for the unconfigured set is unmonitored',
      );
    }
    startAssetDriftWatcher({
      intervalMs: env.LOOP_ASSET_DRIFT_WATCHER_INTERVAL_SECONDS * 1000,
      thresholdStroops: env.LOOP_ASSET_DRIFT_THRESHOLD_STROOPS,
    });
  } else {
    markWorkerDisabled('asset_drift_watcher', 'no LOOP issuers configured');
  }

  // A2-905 / ADR 009: interest accrual scheduler. Zero bps →
  // feature-off; skip silently so a deployment that hasn't
  // received legal sign-off stays quiet instead of warning on
  // every boot. Non-zero bps turns on the tick.
  if (env.INTEREST_APY_BASIS_POINTS > 0) {
    startInterestScheduler({
      period: {
        apyBasisPoints: env.INTEREST_APY_BASIS_POINTS,
        periodsPerYear: env.INTEREST_PERIODS_PER_YEAR,
      },
      intervalMs: env.INTEREST_TICK_INTERVAL_HOURS * 60 * 60 * 1000,
    });
    // Pool depletion watcher (ADR 009 / 015 forward-mint pool).
    // Only meaningful when interest is on AND at least one LOOP-
    // asset issuer is configured — otherwise there's nothing to
    // forward-mint against.
    if (configuredLoopPayableAssets().length > 0) {
      startInterestPoolWatcher({
        apyBasisPoints: env.INTEREST_APY_BASIS_POINTS,
        minDaysOfCover: resolvePoolMinDaysCover(),
        intervalMs: INTEREST_POOL_WATCHER_DEFAULT_INTERVAL_MS,
      });
    }
  } else {
    markWorkerDisabled('interest_scheduler', 'interest APY is zero');
  }
} else {
  markWorkerDisabled('payment_watcher', 'LOOP_WORKERS_ENABLED is false');
  markWorkerDisabled('procurement_worker', 'LOOP_WORKERS_ENABLED is false');
  markWorkerDisabled('payout_worker', 'LOOP_WORKERS_ENABLED is false');
  markWorkerDisabled('asset_drift_watcher', 'LOOP_WORKERS_ENABLED is false');
  markWorkerDisabled('interest_scheduler', 'LOOP_WORKERS_ENABLED is false');
}

logger.info({ port: env.PORT }, 'Loop backend starting');

const server = serve({ fetch: app.fetch, port: env.PORT });

// Graceful shutdown — let in-flight requests complete before exiting.
// Guarded so a second signal (e.g. SIGINT after SIGTERM, or a
// second SIGTERM from an impatient orchestrator) doesn't re-enter
// server.close or register a second force-exit timer.
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) {
    logger.info({ signal }, 'Additional shutdown signal received, ignoring');
    return;
  }
  shuttingDown = true;

  logger.info({ signal }, 'Received shutdown signal, closing server');
  // Cancel the pending location-refresh kickoff so it doesn't start a fresh
  // upstream call after we've begun draining.
  clearTimeout(locationStartTimer);
  // Stop background intervals so they don't pin the event loop open past
  // server drain.
  stopCleanupInterval();
  stopMerchantRefresh();
  stopLocationRefresh();
  stopPaymentWatcher();
  stopProcurementWorker();
  stopPayoutWorker();
  stopAssetDriftWatcher();
  stopInterestScheduler();
  stopInterestPoolWatcher();

  server.close(() => {
    void Promise.allSettled([sentryFlush(5000), closeDb()]).finally(() => {
      logger.info('Server closed, exiting');
      process.exit(0);
    });
  });
  // Force exit after 10s if connections don't drain. .unref() so this timer
  // never keeps the event loop alive on its own — if everything closes
  // cleanly first, process.exit(0) above wins.
  setTimeout(() => {
    logger.warn('Forcing exit after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Crash handlers. Node's default on an unhandled rejection in recent
// versions is to terminate, skipping our graceful path. Log first, then
// hand off to the normal shutdown so in-flight requests get a chance to
// drain and Sentry gets flushed.
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
  shutdown('unhandledRejection');
});
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception');
  shutdown('uncaughtException');
});
