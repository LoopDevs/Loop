/**
 * SEO URL helpers for path-based locale routing (ADR 034 §5).
 *
 * The make-or-break SEO detail is avoiding duplicate-content collapse across the
 * English country variants:
 *   - **Self-referencing canonicals** — `/gb/en/x` canonicals to itself, never
 *     cross-canonical to `/us/en` (that would deindex the variants).
 *   - **Reciprocal `hreflang` + `x-default`** — emitted from the sitemap (single
 *     source), so Google can serve a UK page to a UK searcher.
 *
 * Absolute-URL builders live here (canonicals/sitemap need the full origin);
 * relative path prefixing for `<Link>` is in `./locale.ts`.
 */

import {
  COUNTRIES,
  DEFAULT_COUNTRY,
  DEFAULT_LANG,
  countryByCode,
  isSupportedCountryCode,
  isSupportedLang,
} from '@loop/shared';
import { localeTag } from './format.js';

/** Canonical production origin (apex). */
export const SITE_URL = 'https://loopfinance.io';

/** Absolute URL for a page under a locale — `localeUrl('gb','en','/cashback')`. */
export function localeUrl(country: string, lang: string, path: string): string {
  const tail = path === '/' || path === '' ? '' : path.startsWith('/') ? path : `/${path}`;
  return `${SITE_URL}/${country.toLowerCase()}/${lang.toLowerCase()}${tail}`;
}

/**
 * Self-referencing canonical for a localized route. Reads the route params, so
 * the `/gb/en/...` mount canonicals to itself and the legacy unprefixed mount
 * canonicals to the `x-default` (`us/en`) variant — never cross-canonical
 * between countries (ADR 034 §5).
 */
export function canonicalHref(
  params: { country?: string | undefined; lang?: string | undefined },
  path: string,
): string {
  const country = isSupportedCountryCode(params.country) ? params.country! : DEFAULT_COUNTRY;
  const lang = isSupportedLang(params.lang) ? params.lang! : DEFAULT_LANG;
  return localeUrl(country, lang, path);
}

/** Country label for per-country meta copy ("…in the United Kingdom"). */
export function countryLabel(country: string | null | undefined): string | null {
  return countryByCode(country)?.label ?? null;
}

/**
 * Reciprocal `hreflang` alternates for a page path — one `<xhtml:link>` per
 * routed country plus `x-default` (→ `us/en`). The same block is embedded in
 * every country variant's `<url>` in the sitemap, which is what makes the set
 * reciprocal (Google ignores non-reciprocal hreflang).
 */
export function hreflangAlternates(path: string, indent = '    '): string {
  const link = (hreflang: string, country: string): string =>
    `${indent}<xhtml:link rel="alternate" hreflang="${hreflang}" href="${escapeXmlAttr(
      localeUrl(country, DEFAULT_LANG, path),
    )}"/>`;
  return [
    link('x-default', DEFAULT_COUNTRY),
    ...COUNTRIES.map((c) => link(localeTag(DEFAULT_LANG, c.code), c.code)),
  ].join('\n');
}

function escapeXmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
