/**
 * CORS allowlist + middleware factory. Pulled out of `app.ts` so
 * the production-origin set has a single home that's easy to grep
 * for in operator runbooks ("which origins can hit our API in
 * prod?").
 *
 * Production origins:
 * - `https://loopfinance.io` + `https://www.loopfinance.io` — the
 *   web app served from Vercel.
 * - `capacitor://localhost` — Capacitor 3+ default WebView origin
 *   on iOS.
 * - `https://localhost` — Capacitor's WebView origin on Android.
 *
 * Without the two Capacitor schemes, every fetch from the native
 * app to the production API would fail preflight — a
 * "works in dev, CORS errors in production" regression on mobile
 * release that's easy to catch late.
 *
 * A2-1009: `http://localhost` used to be on this list too ("kept
 * for older Capacitor debug builds"). Dropped — debug builds
 * aren't in the App Store / Play Store, so no production user
 * hits that origin, and the allowlist entry was CSRF-adjacent:
 * any attacker-controlled process binding a port on a user's
 * localhost (a malicious npm `postinstall`, a dev-server sidecar,
 * a VS Code extension) could mint cross-origin fetches against
 * production API routes using the user's cookies / stored bearer.
 * The canonical Capacitor schemes above cover every shipping
 * native build.
 */
import { cors } from 'hono/cors';
import { env } from '../env.js';

/**
 * Origins permitted in production. Dev/test allow `*` because the
 * Vite dev server picks an ephemeral port and the e2e harness
 * binds a fresh localhost loopback per run.
 */
export const PRODUCTION_ORIGINS = [
  'https://loopfinance.io',
  'https://www.loopfinance.io',
  'capacitor://localhost',
  'https://localhost',
];

/**
 * Hono CORS middleware. Returns the prod-allowlist setup in
 * `NODE_ENV=production`, `*` everywhere else.
 */
export const corsMiddleware = cors({
  origin: env.NODE_ENV === 'production' ? PRODUCTION_ORIGINS : '*',
});
