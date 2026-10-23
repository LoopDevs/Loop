// public client config — ADR 010, ADR 013, ADR 014, ADR 052, P2-14
import type { Context } from 'hono';
import { config } from '../config/index.js';
import {
  loopCountries,
  loopCryptoPaymentCurrencies,
  loopFiatPaymentCurrencies,
  loopStableCurrencies,
} from '../ctx/startup.js';

export interface AppConfig {
  /**
   * ADR 052 — chain-qualified CTX payment currencies the customer can
   * choose at checkout (`LOOP_CTX_PAYMENT_CURRENCIES`, default `XLM`).
   * `POST /api/orders/loop` validates `cryptoCurrency` against this list.
   */
  ctxPaymentCurrencies: string[];
  fiatPaymentCurrencies: string[];
  countries: string[];
  stableCurrencies: string[];
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
    ctxPaymentCurrencies: loopCryptoPaymentCurrencies(),
    fiatPaymentCurrencies: loopFiatPaymentCurrencies(),
    countries: loopCountries(),
    stableCurrencies: loopStableCurrencies(),
    social: {
      googleClientIdWeb: config.auth.social.google.web ?? null,
      googleClientIdIos: config.auth.social.google.ios ?? null,
      googleClientIdAndroid: config.auth.social.google.android ?? null,
      appleServiceId: config.auth.social.apple.serviceId ?? null,
    },
    minSupportedVersion: {
      ios: config.mobile.minSupportedVersion.ios ?? null,
      android: config.mobile.minSupportedVersion.android ?? null,
    },
  };
  // 10-minute client cache is generous but safe — the operator
  // flipping a flag is not a rapid-iteration loop, and caching keeps
  // cold starts (every tab on loopfinance.io) from hammering /config.
  c.header('Cache-Control', 'public, max-age=600');
  return c.json(body);
}
