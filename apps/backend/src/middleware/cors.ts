// CORS allowlist + middleware factory — A2-1009
import { cors } from 'hono/cors';
import { config } from '../config/index.js';

// `http://localhost` dropped (A2-1009): any local process could mint cross-origin fetches with user cookies
export const PRODUCTION_ORIGINS = [
  'https://loopfinance.io',
  'https://www.loopfinance.io',
  'https://beta.loopfinance.io',
  'capacitor://localhost',
  'https://localhost',
];

export const corsMiddleware = cors({
  origin: config.env === 'production' ? PRODUCTION_ORIGINS : '*',
});
