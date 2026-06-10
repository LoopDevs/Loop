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

/**
 * Prefix an app path with a locale → `localizedHref('/cashback', {country:'gb',
 * lang:'en'})` is `'/gb/en/cashback'`. Idempotent: a path that already carries
 * a locale prefix is re-pointed at `locale`, never double-prefixed. Query and
 * hash are preserved.
 */
export function localizedHref(path: string, locale: Locale): string {
  const prefix = `/${locale.country}/${locale.lang}`;
  const cleaned = (path || '/').replace(LOCALE_PREFIX, '');
  const rest =
    cleaned === '/' || cleaned === '' ? '' : cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
  return `${prefix}${rest}`;
}

/** Hook form bound to the active locale — `const href = useLocalizedHref()`. */
export function useLocalizedHref(): (path: string) => string {
  const locale = useLocale();
  return (path: string) => localizedHref(path, locale);
}
