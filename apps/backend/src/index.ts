import { serve } from '@hono/node-server';
import { env } from './env.js';
import { logger } from './logger.js';
import { app } from './app.js';
import { startLocationRefresh } from './clustering/data-store.js';
import { startMerchantRefresh } from './merchants/sync.js';

startLocationRefresh();
startMerchantRefresh();

const port = parseInt(env.PORT, 10);
logger.info({ port }, 'Loop backend starting');

serve({ fetch: app.fetch, port });
