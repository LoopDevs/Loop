/**
 * i18next bootstrap (ADR 043 / B-6 tranche 1).
 *
 * Supersedes the hand-rolled `t()`/`messages.ts` PHASE-2 SCAFFOLD (cold-audit
 * CF-22) — see ADR 043 for why the framework lands now even though
 * `SUPPORTED_LANGS` is still `['en']`: the FRAMEWORK + EXTRACTION work is
 * language-agnostic and unblocks translation the moment a second language is
 * an operator decision, without also needing a from-scratch extraction at
 * that point.
 *
 * All resources are bundled at build time (imported as JSON, one namespace
 * per feature area — see `locales/en/*.json`) and passed to `.init()`
 * synchronously. No `i18next-http-backend`, no lazy namespace loading: this
 * is what makes `i18next.isInitialized` true the instant this module's
 * side effect runs, with no `await`/Suspense needed anywhere — required for
 * both the SSR path (loopfinance.io) and the static mobile export
 * (`BUILD_TARGET=mobile`, no server round-trip to fetch a catalogue from).
 *
 * No `i18next-browser-languagedetector` either — the active locale is the
 * URL's `/:country/:lang` segment (ADR 034), never `navigator.language`.
 * Detecting from the browser would reintroduce exactly the "US flash"
 * ADR 034 was written to kill (server and client would disagree on first
 * paint until a client-only detector resolved). `~/i18n/locale.ts`'s
 * `useLocale()` stays the single source of truth for which locale is
 * active; `root.tsx` threads it into `i18n.changeLanguage()` the same way
 * it already drives `<html lang>`/`<html dir>` (A11Y-011 / I18N-003).
 *
 * Single shared module-scope instance. This is safe *today* because every
 * request/render resolves to the same `lng: 'en'` (only language shipped) —
 * `changeLanguage('en')` is idempotent no matter which request calls it, so
 * there is no cross-request mutation race yet. This is NOT safe to keep
 * as-is once a second language ships: concurrent SSR requests for two
 * different locales would race on this shared instance's `language`
 * property. Follow-up: `docs/i18n.md` "Adding a language" §SSR.
 */
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import common from './locales/en/common.json';
import footer from './locales/en/footer.json';
import navbar from './locales/en/navbar.json';
import trustlines from './locales/en/trustlines.json';
import notFound from './locales/en/notFound.json';
import home from './locales/en/home.json';
import auth from './locales/en/auth.json';
import onboarding from './locales/en/onboarding.json';
import settings from './locales/en/settings.json';
import orders from './locales/en/orders.json';
import giftCard from './locales/en/giftCard.json';
import mobileHome from './locales/en/mobileHome.json';
import brand from './locales/en/brand.json';
import map from './locales/en/map.json';
import cashback from './locales/en/cashback.json';
import wallet from './locales/en/wallet.json';

// Only `en` ships (`SUPPORTED_LANGS` in `@loop/shared`) — this resources map
// is intentionally single-language. Adding a locale is a resources-map + JSON
// files change (see docs/i18n.md), not a framework change.
export const defaultNS = 'common';

void i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  supportedLngs: ['en'],
  ns: [
    'common',
    'footer',
    'navbar',
    'trustlines',
    'notFound',
    'home',
    'auth',
    'onboarding',
    'settings',
    'orders',
    'giftCard',
    'mobileHome',
    'brand',
    'map',
    'cashback',
    'wallet',
  ],
  defaultNS,
  resources: {
    en: {
      common,
      footer,
      navbar,
      trustlines,
      notFound,
      home,
      auth,
      onboarding,
      settings,
      orders,
      giftCard,
      mobileHome,
      brand,
      map,
      cashback,
      wallet,
    },
  },
  // React already escapes interpolated values (JSX text nodes are never
  // raw-inserted as HTML), so i18next's own HTML-escaping pass is redundant
  // and would double-escape entities like `&` in a merchant name.
  interpolation: { escapeValue: false },
  // Suspense-based loading is for async backends (http-backend, lazy
  // namespaces). Resources are synchronous here, so useSuspense would only
  // add a pointless Suspense boundary requirement to every t()-calling
  // component with zero benefit.
  react: { useSuspense: false },
});

export default i18next;
