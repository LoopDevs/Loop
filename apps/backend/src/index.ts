import { serve } from '@hono/node-server';
import { flush as sentryFlush } from '@sentry/hono/node';
import { env } from './env.js';
import { logger } from './logger.js';
import { app, stopCleanupInterval } from './app.js';
import { startLocationRefresh, stopLocationRefresh } from './clustering/data-store.js';
import { startMerchantRefresh, stopMerchantRefresh } from './merchants/sync.js';
import { runMigrations, closeDb } from './db/client.js';

// Apply any pending DB migrations before accepting traffic (ADR 012).
// Awaited so `serve()` below only runs after the schema is up-to-date —
// a partial-migration run-time is worse than a slightly-later boot.
await runMigrations();

// Merchants load first (startMerchantRefresh triggers initial refresh).
// Locations start after a short delay to ensure merchant data is available
// for cross-referencing pin logos.
startMerchantRefresh();
const locationStartTimer = setTimeout(() => {
  startLocationRefresh();
}, 3000);

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
