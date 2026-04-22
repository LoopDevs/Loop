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

/**
 * Per-LOOP-asset config snapshot (ADR 015). Surfaces whether the
 * operator has wired up an issuer for a given currency's LOOP asset,
 * and the issuer account itself when it has. Null `issuer` means
 * on-chain cashback is off for that currency; ledger-side cashback
 * still accrues.
 *
 * Exposed on `/api/config` (public) so pre-auth surfaces — the
 * marketing home page, the onboarding wallet-intro screen — can
 * show "USDLOOP live / EURLOOP coming soon" without needing an
 * admin call. No secrets here: the Stellar issuer address is the
 * public key, intended to be visible.
 */
export interface LoopAssetConfig {
  issuer: string | null;
  /** Convenience flag — `issuer !== null`. Lets clients branch on `available` without the null check. */
  available: boolean;
}

export interface AppConfig {
  /** ADR 013: Loop-native auth is active (OTP + JWTs minted by Loop). */
  loopAuthNativeEnabled: boolean;
  /** ADR 010: the order workers are running and Loop-native orders can be placed. */
  loopOrdersEnabled: boolean;
  /**
   * ADR 015 — which LOOP stablecoins are wired for on-chain payout.
   * Always returns all three keys (USDLOOP/GBPLOOP/EURLOOP) so the
   * client can render a stable shape; a currency with `issuer: null`
   * renders as "coming soon" rather than vanishing.
   */
  loopAssets: {
    USDLOOP: LoopAssetConfig;
    GBPLOOP: LoopAssetConfig;
    EURLOOP: LoopAssetConfig;
  };
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

function assetConfig(issuer: string | undefined): LoopAssetConfig {
  const i = issuer ?? null;
  return { issuer: i, available: i !== null };
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
    loopAssets: {
      USDLOOP: assetConfig(env.LOOP_STELLAR_USDLOOP_ISSUER),
      GBPLOOP: assetConfig(env.LOOP_STELLAR_GBPLOOP_ISSUER),
      EURLOOP: assetConfig(env.LOOP_STELLAR_EURLOOP_ISSUER),
    },
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
