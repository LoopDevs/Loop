/**
 * Active-locale access + link prefixing (ADR 034 Phase 2).
 *
 * The locale lives in the URL path (`/:country/:lang`), so reading it is just
 * `useParams()` with a fall-back to the default market for the legacy
 * unprefixed routes that don't carry the segments. `localizedHref()` is the
 * single helper every `<Link>` / `navigate()` on the localised surface goes
 * through (wired in Phase 3) so a click keeps the visitor in their country.
 *
 * Pure + SSR-safe: no browser globals, no store — the URL is the source of
 * truth, which is what removes the US flash (the country is known on the first
 * server byte, never corrected on the client).
 */

import { useParams } from 'react-router';
import {
  DEFAULT_COUNTRY,
  DEFAULT_LANG,
  isSupportedCountryCode,
  isSupportedLang,
} from '@loop/shared';

export interface Locale {
  /** Lowercased ISO 3166-1 alpha-2 country segment (e.g. `'gb'`). */
  country: string;
  /** Lowercased language segment (e.g. `'en'`). */
  lang: string;
}

/** The default market a bare / unrouted locale resolves to. */
export const DEFAULT_LOCALE: Locale = {
  country: DEFAULT_COUNTRY.toLowerCase(),
  lang: DEFAULT_LANG,
};

/**
 * Coerce raw URL segments to a valid {@link Locale}, falling back to
 * {@link DEFAULT_LOCALE} for anything we don't route. Lowercased for the path.
 */
export function normalizeLocale(country?: string | null, lang?: string | null): Locale {
  return {
    country: isSupportedCountryCode(country) ? country!.toLowerCase() : DEFAULT_LOCALE.country,
    lang: isSupportedLang(lang) ? lang!.toLowerCase() : DEFAULT_LOCALE.lang,
  };
}

/** The active locale from the route params (default market on unprefixed routes). */
export function useLocale(): Locale {
  const params = useParams();
  return normalizeLocale(params.country, params.lang);
}

const LOCALE_PREFIX = /^\/[a-z]{2}\/[a-z]{2}(?=\/|$)/;

/** Strip a leading `/xx/yy` locale prefix from a path (no-op if absent). */
export function stripLocale(path: string): string {
  return (path || '/').replace(LOCALE_PREFIX, '') || '/';
}

/**
 * Prefix an app path with a locale → `localizedHref('/cashback', {country:'gb',
 * lang:'en'})` is `'/gb/en/cashback'`. Idempotent: a path that already carries
 * a locale prefix is re-pointed at `locale`, never double-prefixed. Query and
 * hash are preserved.
 */
export function localizedHref(path: string, locale: Locale): string {
  const prefix = `/${locale.country}/${locale.lang}`;
  const cleaned = stripLocale(path);
  const rest = cleaned === '/' ? '' : cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
  return `${prefix}${rest}`;
}

/** Hook form bound to the active locale — `const href = useLocalizedHref()`. */
export function useLocalizedHref(): (path: string) => string {
  const locale = useLocale();
  return (path: string) => localizedHref(path, locale);
}

// The unprefixed paths that have a `/:country/:lang` mount (ADR 034 — the public
// catalogue + onboarding). Used by the country selector to decide whether
// switching country can stay on the same page or should land on the locale home.
const LOCALIZABLE_PATHS = [
  /^\/$/,
  /^\/map(\/|$)/,
  /^\/gift-card(\/|$)/,
  /^\/brand(\/|$)/,
  /^\/cashback(\/|$)/,
  /^\/calculator(\/|$)/,
  /^\/trustlines(\/|$)/,
  /^\/privacy(\/|$)/,
  /^\/terms(\/|$)/,
  /^\/onboarding(\/|$)/,
];

/** Does this path (locale prefix ignored) have a localized mount? */
export function isLocalizablePath(path: string): boolean {
  const stripped = stripLocale(path).split(/[?#]/)[0] ?? '/';
  return LOCALIZABLE_PATHS.some((re) => re.test(stripped));
}

/** Cookie that persists the visitor's explicit country choice (no PII). */
export const COUNTRY_COOKIE = 'loop_country';

/**
 * Read the saved country from a Cookie header (server) or `document.cookie`
 * (client). Returns a lowercased routed country, or `null` if absent/unrouted.
 */
export function parseCountryCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === COUNTRY_COOKIE && isSupportedCountryCode(value)) return value.toLowerCase();
  }
  return null;
}

/** Client-side read of the saved country choice. */
export function readCountryCookie(): string | null {
  if (typeof document === 'undefined') return null;
  return parseCountryCookie(document.cookie);
}

/** Persist the visitor's explicit country choice (client-only, 1-year, Lax). */
export function setCountryCookie(country: string): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${COUNTRY_COOKIE}=${country.toLowerCase()}; path=/; max-age=31536000; SameSite=Lax`;
}
