import { serve } from '@hono/node-server';
import { flush as sentryFlush } from '@sentry/hono/node';
import { env } from './env.js';
import { logger } from './logger.js';
import { app, stopCleanupInterval, stopFleetSizeEstimator } from './app.js';
import { startLocationRefresh, stopLocationRefresh } from './clustering/data-store.js';
import { startMerchantRefresh, stopMerchantRefresh } from './merchants/sync.js';
import { runMigrations, closeDb } from './db/client.js';
import { startPaymentWatcher, stopPaymentWatcher } from './payments/watcher.js';
import { startProcurementWorker, stopProcurementWorker } from './orders/procurement.js';
import { startRedemptionBackfill, stopRedemptionBackfill } from './orders/redemption-backfill.js';
import {
  startPayoutWorker,
  stopPayoutWorker,
  resolvePayoutConfig,
} from './payments/payout-worker.js';
import { startAssetDriftWatcher, stopAssetDriftWatcher } from './payments/asset-drift-watcher.js';
import {
  startOperatorFloatReconciliationWatcher,
  stopOperatorFloatReconciliationWatcher,
} from './payments/operator-float-reconciliation.js';
import {
  startInterestPoolWatcher,
  stopInterestPoolWatcher,
  INTEREST_POOL_WATCHER_DEFAULT_INTERVAL_MS,
  resolvePoolMinDaysCover,
} from './payments/interest-pool-watcher.js';
import { configuredLoopPayableAssets } from './credits/payout-asset.js';
import { startInterestScheduler, stopInterestScheduler } from './credits/interest-scheduler.js';
import { startAuthRowPurge, stopAuthRowPurge } from './auth/auth-row-purge.js';
import {
  startLedgerInvariantWatcher,
  stopLedgerInvariantWatcher,
} from './credits/ledger-invariant-watcher.js';
import { startInterestMintWorker, stopInterestMintWorker } from './credits/interest-mint.js';
import { resolveIssuerSigners } from './payments/issuer-signers.js';
import { startWalletProvisioning, stopWalletProvisioning } from './wallet/provisioning.js';
import {
  startVaultEmissionSweep,
  stopVaultEmissionSweep,
} from './credits/vaults/vault-emissions.js';
import {
  startVaultRedemptionSweep,
  stopVaultRedemptionSweep,
} from './credits/vaults/vault-redemptions.js';
import { vaultsEnabled } from './credits/vaults/registry.js';
import {
  startVaultDriftWatcher,
  stopVaultDriftWatcher,
} from './credits/vaults/vault-drift-watcher.js';
import {
  startVaultFloatReconciliationWatcher,
  stopVaultFloatReconciliationWatcher,
} from './treasury/hot-float-reconciliation.js';
import {
  startHotFloatBackingReconciliationWatcher,
  stopHotFloatBackingReconciliationWatcher,
} from './treasury/hot-float-backing-reconciliation.js';
import {
  startVaultApySnapshotWorker,
  stopVaultApySnapshotWorker,
} from './credits/vaults/vault-apy-snapshot.js';
import { markWorkerBlocked, markWorkerDisabled } from './runtime-health.js';
import { getGeoDbStatus } from './public/geo.js';

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

// CF-25 / X-PRIV-03 / NS-10: a single boot warn while gift-card
// redeem-secret encryption is disabled. Codes + PINs are spendable
// bearer instruments; without LOOP_REDEEM_ENCRYPTION_KEY they're
// stored plaintext (legacy behaviour) and any logical DB read yields
// spendable codes. NS-10: PRODUCTION now fails closed on an unset key
// in `env.ts` (parseEnv throws before this file runs), so this branch
// only ever fires in dev/test — where warn-and-allow is intentional so
// local work isn't blocked on generating a key. Set a 32-byte key
// (base64 / hex) to activate AES-256-GCM at rest; existing plaintext
// rows are encrypted by `scripts/backfill-redeem-encryption.ts`.
if (env.LOOP_REDEEM_ENCRYPTION_KEY === undefined || env.LOOP_REDEEM_ENCRYPTION_KEY === '') {
  logger.warn(
    'LOOP_REDEEM_ENCRYPTION_KEY is unset — gift-card redeem codes/PINs are stored PLAINTEXT at rest (CF-25 / X-PRIV-03). Set a 32-byte key (e.g. `openssl rand -base64 32`) to encrypt them with AES-256-GCM.',
  );
}

// go-live-plan §T1-F: one-time boot diagnostic for the GeoLite2-Country
// `.mmdb` staleness signal. `stale` covers BOTH "configured but failed to
// open" (bad path / a deploy that forgot the BuildKit secrets) and "opened
// fine but the build is old" — it's deliberately false when
// MAXMIND_GEOLITE2_PATH was never set at all, since that's a valid
// dev/staging posture, not a misconfiguration. `/health` re-surfaces this
// live on every probe (`geoDbStale` + `geo_db_stale` in
// softDegradedReasons) and pages Discord at most once a week
// (`notifyGeoDbStale` in health.ts) — this boot line is just the earliest
// possible signal for an operator watching deploy logs.
const geoDbStatus = await getGeoDbStatus();
if (geoDbStatus.stale) {
  logger.warn(
    { available: geoDbStatus.available, buildEpoch: geoDbStatus.buildEpoch },
    geoDbStatus.available
      ? `GeoLite2-Country .mmdb is stale (built ${geoDbStatus.ageDays} days ago) — redeploy with the two --build-secret flags (docs/deployment.md §GeoLite2) to refresh it.`
      : 'MAXMIND_GEOLITE2_PATH is configured but the .mmdb failed to open — the `/` geo-redirect first-guess is falling back to the US default (ADR 034). Redeploy with the two --build-secret flags (docs/deployment.md §GeoLite2).',
  );
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
await startMerchantRefresh();
const locationStartTimer = setTimeout(() => {
  void startLocationRefresh();
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
    markWorkerBlocked('operator_float_reconciliation', {
      reason: 'LOOP_STELLAR_DEPOSIT_ADDRESS is unset',
      staleAfterMs: env.LOOP_OPERATOR_FLOAT_RECONCILIATION_INTERVAL_HOURS * 3 * 60 * 60 * 1000,
    });
    logger.error(
      'LOOP_WORKERS_ENABLED=true but LOOP_STELLAR_DEPOSIT_ADDRESS is unset — payment watcher and operator-float reconciliation will not start',
    );
  } else {
    startPaymentWatcher({
      account: env.LOOP_STELLAR_DEPOSIT_ADDRESS,
      ...(env.LOOP_STELLAR_USDC_ISSUER !== undefined
        ? { usdcIssuer: env.LOOP_STELLAR_USDC_ISSUER }
        : {}),
      intervalMs: env.LOOP_PAYMENT_WATCHER_INTERVAL_SECONDS * 1000,
    });
    startOperatorFloatReconciliationWatcher({
      intervalMs: env.LOOP_OPERATOR_FLOAT_RECONCILIATION_INTERVAL_HOURS * 60 * 60 * 1000,
    });
  }
  startProcurementWorker({
    intervalMs: env.LOOP_PROCUREMENT_INTERVAL_SECONDS * 1000,
  });
  // Redemption-backfill sweeper — backstops waitForRedemption's
  // budget-exhaustion path: fulfilled orders that captured a
  // ctx_order_id but no redemption payload get re-fetched with
  // backoff until recovered or the attempts cap pages ops.
  startRedemptionBackfill();
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

  // Interest — exactly ONE writer may ever run (ADR 031 / ADR 036):
  //
  //   - LOOP_INTEREST_ONCHAIN_ENABLED=true → the interest-mint worker
  //     (nightly on-chain mint mirrored into user_credits in one txn,
  //     Phase D). The legacy scheduler is structurally never started
  //     on this branch, and `startInterestScheduler` additionally
  //     hard-throws on the flag as a tripwire against re-wiring.
  //   - flag false → the legacy off-chain accrual scheduler exactly
  //     as before (A2-905 / ADR 009), which per ADR 036 §3 must stay
  //     disabled (INTEREST_APY_BASIS_POINTS=0) in cashback-mode
  //     deployments until retired.
  if (env.LOOP_INTEREST_ONCHAIN_ENABLED) {
    markWorkerDisabled(
      'interest_scheduler',
      'superseded by on-chain interest mints (LOOP_INTEREST_ONCHAIN_ENABLED=true)',
    );
    if (env.INTEREST_APY_BASIS_POINTS <= 0) {
      markWorkerDisabled('interest_mint', 'interest APY is zero');
    } else if (resolveIssuerSigners().size === 0) {
      markWorkerBlocked('interest_mint', {
        reason: 'no LOOP_STELLAR_*_ISSUER_SECRET configured',
        staleAfterMs: 60 * 60 * 1000,
      });
      logger.error(
        'LOOP_INTEREST_ONCHAIN_ENABLED=true but no LOOP_STELLAR_*_ISSUER_SECRET is configured — interest-mint worker will not start',
      );
    } else {
      startInterestMintWorker({ apyBps: env.INTEREST_APY_BASIS_POINTS });
    }
    // The interest-pool watcher is deliberately NOT started here:
    // the forward-mint pool is a legacy-path construct (pre-minted
    // batch sub-allocated off-chain) — on-chain mints don't use it.
  } else if (env.INTEREST_APY_BASIS_POINTS > 0) {
    markWorkerDisabled('interest_mint', 'LOOP_INTEREST_ONCHAIN_ENABLED is false');
    startInterestScheduler({
      period: {
        apyBasisPoints: env.INTEREST_APY_BASIS_POINTS,
        periodsPerYear: env.INTEREST_PERIODS_PER_YEAR,
      },
      intervalMs: env.INTEREST_TICK_INTERVAL_HOURS * 60 * 60 * 1000,
    });
    // Pool depletion watcher (ADR 009 / 015 forward-mint pool).
    // Only meaningful when legacy interest is on AND at least one
    // LOOP-asset issuer is configured — otherwise there's nothing
    // to forward-mint against.
    if (configuredLoopPayableAssets().length > 0) {
      startInterestPoolWatcher({
        apyBasisPoints: env.INTEREST_APY_BASIS_POINTS,
        minDaysOfCover: resolvePoolMinDaysCover(),
        intervalMs: INTEREST_POOL_WATCHER_DEFAULT_INTERVAL_MS,
      });
    }
  } else {
    markWorkerDisabled('interest_scheduler', 'interest APY is zero');
    markWorkerDisabled('interest_mint', 'interest APY is zero');
  }

  // CF-26 / X-PRIV-07/08 + AGT-06: auth-row retention purge. Deletes
  // expired/consumed OTP rows, dead refresh-token rows, and expired
  // social id-token replay-guard rows past the retention grace so none
  // of these auth tables grow without bound. DELETE-only, no Stellar /
  // CTX dependency — gated here purely to share the workers' lifecycle.
  // Runbook: docs/runbooks/dsr.md.
  startAuthRowPurge({
    intervalMs: env.LOOP_AUTH_ROW_PURGE_INTERVAL_HOURS * 60 * 60 * 1000,
  });

  // Hardening C1 (2026-07 plan): scheduled ledger-invariant check —
  // pages Discord while user_credits disagrees with the
  // credit_transactions sum anywhere. The check itself single-flights
  // across machines via a transaction-scoped advisory lock; DB-only,
  // no Stellar / CTX dependency — gated here to share the workers'
  // lifecycle.
  startLedgerInvariantWatcher({
    intervalMs: env.LOOP_LEDGER_INVARIANT_INTERVAL_HOURS * 60 * 60 * 1000,
  });

  // ADR 030 Phase C1 — wallet-provisioning sweeper. Re-drives stuck
  // signup-time provisioning with backoff and backfills existing
  // users that hold user_credits. Only meaningful when the embedded
  // wallet layer is on.
  if (env.LOOP_WALLET_PROVIDER !== '') {
    startWalletProvisioning();
  } else {
    markWorkerDisabled('wallet_provisioning', 'LOOP_WALLET_PROVIDER is unset');
  }

  // ADR 031 §D5/D9 (V3) — vault cashback-emission sweep. Only
  // meaningful once the vault subsystem itself is on; with
  // `LOOP_VAULTS_ENABLED=false` (default) `orders/fulfillment.ts`'s
  // gated fork never claims a `vault_emissions` row, so an unstarted
  // sweep here is consistent, not merely inert.
  if (vaultsEnabled()) {
    startVaultEmissionSweep();
    // ADR 031 §D6 (V4) — vault WITHDRAW/REDEEM sweep. Same gating
    // reasoning as the emission sweep above: with vaults off,
    // `orders/redeem.ts`'s gated fork never claims a `vault_redemptions`
    // row, so an unstarted sweep here is consistent, not merely inert.
    startVaultRedemptionSweep();
    // ADR 031 §D4 (V5) — vault drift + solvency watcher and the
    // vault-aware hot-float reconciliation. Same gating reasoning:
    // with vaults off there is no vault state to observe (the
    // registry is only ever read when `vaultsEnabled()`), so an
    // unstarted watcher here is consistent, not merely inert.
    startVaultDriftWatcher();
    startVaultFloatReconciliationWatcher();
    // NS-06 — hot-float USDC-BACKING reconciliation (the balance twin of
    // the SHARE reconciler above). Same gating: with vaults off there is
    // no vault hot float to reconcile, so an unstarted watcher here is
    // consistent, not merely inert.
    startHotFloatBackingReconciliationWatcher();
    // ADR 031 §D8 (V5b) — APY snapshot cron. Same gating reasoning:
    // with vaults off there's no live share price to snapshot (the
    // registry is only ever read when `vaultsEnabled()`), so an
    // unstarted cron here is consistent, not merely inert.
    startVaultApySnapshotWorker();
  } else {
    markWorkerDisabled('vault_emission_sweep', 'LOOP_VAULTS_ENABLED is false');
    markWorkerDisabled('vault_redemption_sweep', 'LOOP_VAULTS_ENABLED is false');
    markWorkerDisabled('vault_drift_watcher', 'LOOP_VAULTS_ENABLED is false');
    markWorkerDisabled('vault_float_reconciliation', 'LOOP_VAULTS_ENABLED is false');
    markWorkerDisabled('hot_float_backing_reconciliation', 'LOOP_VAULTS_ENABLED is false');
    markWorkerDisabled('vault_apy_snapshot', 'LOOP_VAULTS_ENABLED is false');
  }
} else {
  markWorkerDisabled('payment_watcher', 'LOOP_WORKERS_ENABLED is false');
  markWorkerDisabled('operator_float_reconciliation', 'LOOP_WORKERS_ENABLED is false');
  markWorkerDisabled('procurement_worker', 'LOOP_WORKERS_ENABLED is false');
  markWorkerDisabled('redemption_backfill', 'LOOP_WORKERS_ENABLED is false');
  markWorkerDisabled('payout_worker', 'LOOP_WORKERS_ENABLED is false');
  markWorkerDisabled('asset_drift_watcher', 'LOOP_WORKERS_ENABLED is false');
  markWorkerDisabled('interest_scheduler', 'LOOP_WORKERS_ENABLED is false');
  markWorkerDisabled('auth_row_purge', 'LOOP_WORKERS_ENABLED is false');
  markWorkerDisabled('interest_mint', 'LOOP_WORKERS_ENABLED is false');
  markWorkerDisabled('wallet_provisioning', 'LOOP_WORKERS_ENABLED is false');
  markWorkerDisabled('vault_emission_sweep', 'LOOP_WORKERS_ENABLED is false');
  markWorkerDisabled('vault_redemption_sweep', 'LOOP_WORKERS_ENABLED is false');
  markWorkerDisabled('vault_drift_watcher', 'LOOP_WORKERS_ENABLED is false');
  markWorkerDisabled('vault_float_reconciliation', 'LOOP_WORKERS_ENABLED is false');
  markWorkerDisabled('vault_apy_snapshot', 'LOOP_WORKERS_ENABLED is false');
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
  stopFleetSizeEstimator();
  stopMerchantRefresh();
  stopLocationRefresh();
  stopPaymentWatcher();
  stopOperatorFloatReconciliationWatcher();
  stopProcurementWorker();
  stopRedemptionBackfill();
  stopPayoutWorker();
  stopAssetDriftWatcher();
  stopInterestScheduler();
  stopInterestMintWorker();
  stopInterestPoolWatcher();
  stopAuthRowPurge();
  stopLedgerInvariantWatcher();
  stopWalletProvisioning();
  stopVaultEmissionSweep();
  stopVaultRedemptionSweep();
  stopVaultDriftWatcher();
  stopVaultFloatReconciliationWatcher();
  stopHotFloatBackingReconciliationWatcher();
  stopVaultApySnapshotWorker();

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
