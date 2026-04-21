/**
 * Public client config (ADR 010 / ADR 013).
 *
 * Returns the feature flags the web client needs to decide which code
 * paths to take — e.g. whether to call `POST /api/orders/loop`
 * (Loop-native flow) or the legacy `POST /api/orders` (CTX proxy).
 *
 * Unauthenticated on purpose: these flags are effectively "did the
 * operator turn this on?" and the client needs the answer before it
 * has a bearer token. Never include anything sensitive here.
 */
import type { Context } from 'hono';
import { env } from '../env.js';

export interface AppConfig {
  /** ADR 013: Loop-native auth is active (OTP + JWTs minted by Loop). */
  loopAuthNativeEnabled: boolean;
  /** ADR 010: the order workers are running and Loop-native orders can be placed. */
  loopOrdersEnabled: boolean;
  /**
   * ADR 014 social-login client identifiers. Public on purpose: the web /
   * mobile bundle includes these to initialise the Google / Apple SDKs.
   * Per-platform — the client picks the id matching its own platform
   * (the backend accepts any of them as audience).
   */
  social: {
    googleClientIdWeb: string | null;
    googleClientIdIos: string | null;
    googleClientIdAndroid: string | null;
    appleServiceId: string | null;
  };
}

export function configHandler(c: Context): Response {
  const body: AppConfig = {
    loopAuthNativeEnabled: env.LOOP_AUTH_NATIVE_ENABLED,
    // `LOOP_WORKERS_ENABLED` controls the watcher + procurement workers.
    // Without workers the client can still create a loop order, but it
    // would sit in pending_payment forever — gate the UI on both.
    loopOrdersEnabled:
      env.LOOP_AUTH_NATIVE_ENABLED &&
      env.LOOP_WORKERS_ENABLED &&
      env.LOOP_STELLAR_DEPOSIT_ADDRESS !== undefined,
    social: {
      googleClientIdWeb: env.GOOGLE_OAUTH_CLIENT_ID_WEB ?? null,
      googleClientIdIos: env.GOOGLE_OAUTH_CLIENT_ID_IOS ?? null,
      googleClientIdAndroid: env.GOOGLE_OAUTH_CLIENT_ID_ANDROID ?? null,
      appleServiceId: env.APPLE_SIGN_IN_SERVICE_ID ?? null,
    },
  };
  // 10-minute client cache is generous but safe — the operator
  // flipping a flag is not a rapid-iteration loop, and caching keeps
  // cold starts (every tab on loopfinance.io) from hammering /config.
  c.header('Cache-Control', 'public, max-age=600');
  return c.json(body);
}
