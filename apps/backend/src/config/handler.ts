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
import { ctxPaymentCurrencies } from '../orders/loop-handler.js';

export interface AppConfig {
  /** ADR 013: Loop-native auth is active (OTP + JWTs minted by Loop). */
  loopAuthNativeEnabled: boolean;
  /** ADR 010: the order workers are running and Loop-native orders can be placed. */
  loopOrdersEnabled: boolean;
  /**
   * ADR 052 — chain-qualified CTX payment currencies the customer can
   * choose at checkout (`LOOP_CTX_PAYMENT_CURRENCIES`, default `XLM`).
   * `POST /api/orders/loop` validates `cryptoCurrency` against this list.
   */
  ctxPaymentCurrencies: string[];
  /**
   * Tranche 1 (MVP) launch gate. When true, the web client hides
   * every Phase 2+ surface — cashback navbar links, /settings/wallet,
   * /settings/cashback, /cashback rates index, the onboarding
   * currency picker + wallet-intro screens, LinkWalletNudge, and
   * any "you've earned X cashback" copy. The discount badges stay
   * (they ARE the Tranche 1 user proposition).
   *
   * Operator side: leave LOOP issuers + operator secret unset and
   * set `INTEREST_APY_BASIS_POINTS=0` (defaults already do both) —
   * the money-moving workers each gate on that config directly.
   * Flipping `LOOP_PHASE_1_ONLY=false` later is a server-side
   * config change — no app store resubmission needed.
   */
  phase1Only: boolean;
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
  /**
   * P2-14 — the oldest native app build the backend still supports, per
   * platform (dotted numeric, e.g. "0.4.0"). The native shell's
   * `ForceUpdateGate` compares the running client's `X-Client-Version`
   * against the entry for its platform and hard-blocks an older build.
   * `null` = no gate for that platform (the pre-launch default). Web is
   * always served fresh, so it has no minimum and is never included.
   * Server-side source of truth — raising the floor is a config change,
   * not an app-store resubmission.
   */
  minSupportedVersion: {
    ios: string | null;
    android: string | null;
  };
}

export function configHandler(c: Context): Response {
  const body: AppConfig = {
    loopAuthNativeEnabled: env.LOOP_AUTH_NATIVE_ENABLED,
    // ADR 052: ctx is the payment processor. The operator API creds
    // (the CTX create + status mirror transport) are boot-required
    // and the order-mirror machinery always runs, so native auth is
    // the only remaining gate.
    loopOrdersEnabled: env.LOOP_AUTH_NATIVE_ENABLED,
    ctxPaymentCurrencies: ctxPaymentCurrencies(),
    phase1Only: env.LOOP_PHASE_1_ONLY,
    social: {
      googleClientIdWeb: env.GOOGLE_OAUTH_CLIENT_ID_WEB ?? null,
      googleClientIdIos: env.GOOGLE_OAUTH_CLIENT_ID_IOS ?? null,
      googleClientIdAndroid: env.GOOGLE_OAUTH_CLIENT_ID_ANDROID ?? null,
      appleServiceId: env.APPLE_SIGN_IN_SERVICE_ID ?? null,
    },
    minSupportedVersion: {
      ios: env.MIN_SUPPORTED_APP_VERSION_IOS ?? null,
      android: env.MIN_SUPPORTED_APP_VERSION_ANDROID ?? null,
    },
  };
  // 10-minute client cache is generous but safe — the operator
  // flipping a flag is not a rapid-iteration loop, and caching keeps
  // cold starts (every tab on loopfinance.io) from hammering /config.
  c.header('Cache-Control', 'public, max-age=600');
  return c.json(body);
}
