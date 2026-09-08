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
import { startMerchantWs, stopMerchantWs } from './merchants/ws-maintainer.js';
import { initDb, closeDb } from './db/client.js';
import { startGiftcardWs, stopGiftcardWs } from './ctx/giftcard-ws-maintainer.js';
import { startMirrorSweep, stopMirrorSweep } from './orders/ctx-mirror-sweep.js';
import { startRedemptionBackfill, stopRedemptionBackfill } from './orders/redemption-backfill.js';
import { startAuthRowPurge, stopAuthRowPurge } from './auth/auth-row-purge.js';
import { getGeoDbStatus } from './public/geo.js';

// The A4-093 production gate ("native auth enabled with no real email
// provider — every OTP request silently fails while returning 200")
// now lives in `config.ts` alongside the other boot guards, where it
// fails config validation rather than needing a separate check here
// against a raw `process.env` read.

// CF-25 / X-PRIV-03 / NS-10: a single boot warn while gift-card
// redeem-secret encryption is disabled. Codes + PINs are spendable
// bearer instruments; without `orders.redeem.encryptionKey` they're
// stored plaintext and any logical DB read yields spendable codes.
// Production fails closed on an unset key in `config.ts`; this branch
// only ever fires in dev/test — where warn-and-allow is intentional.
if (config.orders.redeem.encryptionKey === undefined) {
  logger.warn(
    'orders.redeem.encryptionKey is unset — gift-card redeem codes/PINs are stored PLAINTEXT at rest (CF-25 / X-PRIV-03). Set a 32-byte key (e.g. `openssl rand -base64 32`) to encrypt them with AES-256-GCM.',
  );
}

// One-time boot diagnostic for the GeoLite2-Country `.mmdb` staleness
// signal. `/health` re-surfaces this live on every probe; this boot
// line is just the earliest possible signal for an operator watching
// deploy logs.
const geoDbStatus = await getGeoDbStatus();
if (geoDbStatus.stale) {
  logger.warn(
    { available: geoDbStatus.available, buildEpoch: geoDbStatus.buildEpoch },
    geoDbStatus.available
      ? `GeoLite2-Country .mmdb is stale (built ${geoDbStatus.ageDays} days ago) — refresh it.`
      : 'catalog.geoip.databasePath is configured but the .mmdb failed to open — the `/` geo-redirect first-guess is falling back to the US default (ADR 034).',
  );
}

// Connect / hydrate the document store before accepting traffic.
await initDb();

// Merchants load first (startMerchantRefresh triggers initial refresh).
// Locations start after a short delay to ensure merchant data is available
// for cross-referencing pin logos.
await startMerchantRefresh();
// Event-driven store maintenance between sweeps (CTX /ws merchant topic).
startMerchantWs();
const locationStartTimer = setTimeout(() => {
  void startLocationRefresh();
}, 3000);

// Order-mirror machinery (ADR 052). ctx is the payment processor and
// these are the only writers of order state — an order can never
// leave `unpaid` without them — so they run unconditionally (the env
// schema requires the operator API creds at boot, so there is no
// unconfigured state to guard). The giftcard ws maintainer pushes
// status onto the mirror; the mirror sweep reconciles missed events
// + payment expiry.
startGiftcardWs();
startMirrorSweep();
// Redemption-backfill sweeper — backstops the fulfil-time
// redemption fetch: fulfilled orders that captured a ctx_order_id
// but no redemption payload get re-fetched with backoff until
// recovered or the attempts cap pages ops.
startRedemptionBackfill();

// CF-26 / X-PRIV-07/08 + AGT-06: auth-row retention purge. Deletes
// expired/consumed OTP rows, dead refresh-token rows, and expired
// social id-token replay-guard rows past the retention grace so none
// of these auth collections grow without bound. Always on.
startAuthRowPurge({
  intervalMs: config.auth.retention.purgeIntervalHours * 60 * 60 * 1000,
});

logger.info({ port: config.server.port }, 'Loop backend starting');

const server = serve({ fetch: app.fetch, port: config.server.port });

// Graceful shutdown — let in-flight requests complete before exiting.
// Guarded so a second signal doesn't re-enter server.close or
// register a second force-exit timer.
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
  stopMerchantWs();
  cancelPendingSnapshotPersist();
  stopLocationRefresh();
  stopGiftcardWs();
  stopMirrorSweep();
  stopRedemptionBackfill();
  stopAuthRowPurge();

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
