import { serve } from '@hono/node-server';
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

serve({ fetch: app.fetch, port });
