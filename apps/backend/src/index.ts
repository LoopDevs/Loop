import { serve } from '@hono/node-server';
import * as Sentry from '@sentry/hono/node';
import { env } from './env.js';
import { logger } from './logger.js';
import { app } from './app.js';
import { startLocationRefresh } from './clustering/data-store.js';
import { startMerchantRefresh } from './merchants/sync.js';

// Merchants load first (startMerchantRefresh triggers initial refresh).
// Locations start after a short delay to ensure merchant data is available
// for cross-referencing pin logos.
startMerchantRefresh();
setTimeout(() => {
  startLocationRefresh();
}, 3000);

const port = parseInt(env.PORT, 10);
logger.info({ port }, 'Loop backend starting');

const server = serve({ fetch: app.fetch, port });

// Graceful shutdown — let in-flight requests complete before exiting
function shutdown(signal: string): void {
  logger.info({ signal }, 'Received shutdown signal, closing server');
  server.close(() => {
    void Sentry.flush(5000).finally(() => {
      logger.info('Server closed, exiting');
      process.exit(0);
    });
  });
  // Force exit after 10s if connections don't drain
  setTimeout(() => {
    logger.warn('Forcing exit after timeout');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
