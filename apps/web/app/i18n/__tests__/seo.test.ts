/** ADR 034 Phase 4 — SEO URL helpers. */
import { describe, it, expect } from 'vitest';
import { canonicalHref, countryLabel, hreflangAlternates, localeUrl, SITE_URL } from '../seo.js';

describe('localeUrl', () => {
  it('builds an absolute locale URL', () => {
    expect(localeUrl('gb', 'en', '/cashback')).toBe(`${SITE_URL}/gb/en/cashback`);
    expect(localeUrl('US', 'EN', '/')).toBe(`${SITE_URL}/us/en`);
    expect(localeUrl('de', 'en', 'cashback')).toBe(`${SITE_URL}/de/en/cashback`);
  });
});

describe('canonicalHref — self-referencing, never cross-canonical', () => {
  it('self-canonicals a localized route', () => {
    expect(canonicalHref({ country: 'gb', lang: 'en' }, '/cashback')).toBe(
      `${SITE_URL}/gb/en/cashback`,
    );
  });
  it('canonicals the legacy unprefixed route to the x-default (us/en)', () => {
    expect(canonicalHref({}, '/cashback')).toBe(`${SITE_URL}/us/en/cashback`);
    expect(canonicalHref({ country: 'zz', lang: 'en' }, '/')).toBe(`${SITE_URL}/us/en`);
  });
});

describe('countryLabel', () => {
  it('returns the human label for a routed country', () => {
    expect(countryLabel('gb')).toBe('United Kingdom');
    expect(countryLabel('DE')).toBe('Germany');
  });
  it('returns null for an unrouted country', () => {
    expect(countryLabel('zz')).toBeNull();
    expect(countryLabel(undefined)).toBeNull();
  });
});

describe('hreflangAlternates', () => {
  const block = hreflangAlternates('/cashback');

  it('includes x-default → us/en and one alternate per routed country', () => {
    expect(block).toContain(
      '<xhtml:link rel="alternate" hreflang="x-default" href="https://loopfinance.io/us/en/cashback"/>',
    );
    expect(block).toContain(
      '<xhtml:link rel="alternate" hreflang="en-GB" href="https://loopfinance.io/gb/en/cashback"/>',
    );
    // 28 countries + x-default = 29 reciprocal links.
    expect(block.split('\n')).toHaveLength(29);
  });
});
