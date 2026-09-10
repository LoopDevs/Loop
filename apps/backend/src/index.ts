import { serve } from '@hono/node-server';
import { flush as sentryFlush } from '@sentry/hono/node';
import { config } from './config/index.js';
import { logger } from './logger.js';
import { app, stopCleanupInterval, stopFleetSizeEstimator } from './app.js';
import { startLocationRefresh, stopLocationRefresh } from './clustering/data-store.js';
import {
  startMerchantRefresh,
  stopMerchantRefresh,
  cancelPendingSnapshotPersist,
} from './merchants/sync.js';
import { registerMerchantWsEvents } from './merchants/ws-events.js';
import { initDb, closeDb } from './db/client.js';
import { registerGiftcardWsEvents } from './orders/ws-events.js';
import { startCtxWs, stopCtxWs } from './ctx/ws-events.js';
import { startMirrorSweep, stopMirrorSweep } from './orders/ctx-mirror-sweep.js';
import { startRedemptionBackfill, stopRedemptionBackfill } from './orders/redemption-backfill.js';
import { startAuthRowPurge, stopAuthRowPurge } from './auth/auth-row-purge.js';
import { getGeoDbStatus } from './public/geo.js';

// CF-25 / X-PRIV-03 / NS-10: warn if gift-card redeem-secret encryption is disabled.
// Codes + PINs are spendable bearer instruments; without `orders.redeem.encryptionKey` they're stored plaintext.
if (config.orders.redeem.encryptionKey === undefined) {
  logger.warn(
    'orders.redeem.encryptionKey is unset — gift-card redeem codes/PINs are stored PLAINTEXT at rest (CF-25 / X-PRIV-03). Set a 32-byte key (e.g. `openssl rand -base64 32`) to encrypt them with AES-256-GCM.',
  );
}

// Boot diagnostic for GeoLite2-Country `.mmdb` staleness.
const geoDbStatus = await getGeoDbStatus();
if (geoDbStatus.stale) {
  logger.warn(
    { available: geoDbStatus.available, buildEpoch: geoDbStatus.buildEpoch },
    geoDbStatus.available
      ? `GeoLite2-Country .mmdb is stale (built ${geoDbStatus.ageDays} days ago) — refresh it.`
      : 'catalog.geoip.databasePath is configured but the .mmdb failed to open — the `/` geo-redirect first-guess is falling back to the US default (ADR 034).',
  );
}

await initDb();

// Merchants load first to ensure data is available for cross-referencing pin logos.
await startMerchantRefresh();
registerMerchantWsEvents();
registerGiftcardWsEvents();
startCtxWs();
const locationStartTimer = setTimeout(() => {
  void startLocationRefresh();
}, 3000);

// Order-mirror machinery (ADR 052). ctx is the payment processor and these are the only writers of order state.
startMirrorSweep();
// Redemption-backfill sweeper — backstops the fulfil-time redemption fetch.
startRedemptionBackfill();

// CF-26 / X-PRIV-07/08 + AGT-06: auth-row retention purge.
startAuthRowPurge({
  intervalMs: config.auth.retention.purgeIntervalHours * 60 * 60 * 1000,
});

logger.info({ port: config.server.port }, 'Loop backend starting');

const server = serve({ fetch: app.fetch, port: config.server.port });

// Graceful shutdown — let in-flight requests complete before exiting.
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) {
    logger.info({ signal }, 'Additional shutdown signal received, ignoring');
    return;
  }
  shuttingDown = true;

  logger.info({ signal }, 'Received shutdown signal, closing server');
  clearTimeout(locationStartTimer);
  stopCleanupInterval();
  stopFleetSizeEstimator();
  stopMerchantRefresh();
  stopCtxWs();
  cancelPendingSnapshotPersist();
  stopLocationRefresh();
  stopMirrorSweep();
  stopRedemptionBackfill();
  stopAuthRowPurge();

  server.close(() => {
    void Promise.allSettled([sentryFlush(5000), closeDb()]).finally(() => {
      logger.info('Server closed, exiting');
      process.exit(0);
    });
  });
  // Force exit after 10s if connections don't drain.
  setTimeout(() => {
    logger.warn('Forcing exit after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Crash handlers. Log first, then hand off to normal shutdown so in-flight requests drain and Sentry flushes.
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
  shutdown('unhandledRejection');
});
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception');
  shutdown('uncaughtException');
});
