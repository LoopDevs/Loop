# ADR 034: Path-based locale routing (`/:country/:lang`)

## Status

Accepted (supersedes the client-only region model in ADR 033)

## Context

ADR 033 shipped a US / CA / UK / EUR region selector as **client-only** state
(`region.store.ts`, localStorage + an IP-geo first guess). Three limitations surfaced:

1. **US flash** — the store initialises to `US` for SSR safety, then corrects on the
   client, so every non-US visitor sees a frame of US content. It's unavoidable while the
   country is client-only state.
2. **"Europe" is too coarse** — one EUR region hides the fact that a Eurozone merchant is
   relevant to a German _and_ a French visitor in their own contexts.
3. **Invisible to search engines** — a client-only region produces one indexable URL for
   all markets; Google can't serve a UK page to a UK searcher.

## Decision

Move the locale into the **URL path**: `beta.loopfinance.io/:country/:lang/...`
(e.g. `/gb/en`, `/de/en`, `/us/en`). The country segment is an ISO 3166-1 alpha-2 code
(lowercased); the language segment is always `en` for now (English-only — the segment
exists to future-proof real localisation like `/de/de`, not because we translate yet).

1. **Per-country, not per-region.** Expand the model to every country we have a
   merchant currency for (US, GB, CA + the Eurozone members + the long-tail currencies the
   supplier sync added — AED/INR/CHF/SEK/… ≈ 40 countries). The exact list is derived from
   the live catalogue's `country` + `currency` spread at build time.

2. **Merchant ↔ country rule.** A merchant shows in country `C` when
   `merchant.country === C` **OR** `merchant.currency === currencyOf(C)`. So a EUR merchant
   surfaces in DE, FR, IT, … (Europe-wide brands appear in each Eurozone country), a GBP
   merchant in GB, etc. No backend change — uses fields we already expose.

3. **Geo-IP becomes one server-side redirect.** `GET /` (no locale) runs an SSR loader that
   resolves the visitor's country via the backend `/api/public/geo` (forwarding the client
   IP) and `302`s to `/<country>/en`, falling back to `/us/en`. This is a **new documented
   loader-fetch exception** (the second after `sitemap.tsx`) — justified because crawlers
   and first-paint both need the redirect server-side. No more US flash: every rendered
   page already knows its country from the URL.

4. **Country-search modal.** With ~40 countries the navbar dropdown becomes a centered
   modal: a search field + flagged list (type "ger" → Germany). Selecting a country
   navigates to the same page under the new locale (`/de/en/...`), so the choice is a real,
   shareable URL — and it's "remembered" by being canonical.

5. **SEO.** Every page emits `hreflang` alternates for its country variants + a canonical;
   the sitemap enumerates `country × lang × page`. The home/marketing pages become the main
   international-SEO surface.

6. **The region store is retired.** `region`/`useRegionStore` is replaced by the URL param
   (a `useLocale()` hook over `useParams`). The onboarding currency guess (ADR 033) reads
   the URL country instead of the store.

## Consequences

- **Routing refactor** — all routes nest under a `($lang).($country)`-style layout; every
  `<Link>` / `navigate()` goes through a `localizedHref()` helper that prefixes the active
  locale. The SSR entry, `root.tsx`, and `sitemap.tsx` all change.
- **Thin long-tail catalogues** — countries whose currency has few allocated merchants will
  render sparse grids until more are synced. Acceptable; the selector still offers them.
- **`/api/public/geo` stays** but its consumer moves from the client store to the `/`
  redirect loader. The MaxMind `.mmdb` (already deployed) backs it.
- **Capacitor (mobile)** has no marketing-SEO need; the native shell pins `/us/en` (or the
  device locale's country) and hides the URL — the modal still lets users switch.

## Phasing

1. **Model + filter** — country list (`countries.ts`), `currencyOf`, the country↔merchant
   predicate; unit-tested. No UI change.
2. **Routing shell** — `($lang).($country)` layout, `useLocale()`, `localizedHref()`, the
   `/` geo-redirect loader, locale validation/404.
3. **Wire consumers** — merchant filters (home/mobile/search), the selector → modal,
   onboarding currency, all `Link`s.
4. **SEO** — `hreflang` + canonical in route `meta`, sitemap expansion.
5. **Cleanup** — retire `region.store.ts`; update `architecture.md` (the new loader
   exception) + docs.
