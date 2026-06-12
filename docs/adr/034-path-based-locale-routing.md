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

3. **Geo-IP is one server-side redirect at `/`.** `GET /` (no locale) `302`s to
   `/<country>/en` (falling back to `/us/en`). It **must be a 302** — the destination varies
   per visitor, so a cached 301 would be wrong. **Two implementations, same behaviour:**
   - **Origin SSR loader (default).** An SSR loader on `/` resolves the country via the
     backend `/api/public/geo` (forwarding the client IP) and redirects. This is a **new
     documented loader-fetch exception** (the second after `sitemap.tsx`). No new vendor;
     the redirect costs one origin hit. We're Fly-direct today (no edge country header), so
     this is where we start.
   - **Cloudflare edge (perf upgrade).** If we later front the web app with Cloudflare, a
     Worker / Redirect Rule on `CF-IPCountry` does the same `302` at the edge — no origin
     round-trip, free geo, and it naturally scopes out bots. Tradeoff: +1 vendor, and
     Cloudflare caching must respect our `Cache-Control`. (This is exactly how bitrefill.com
     redirects `/` → `/gb/en`.)

   Either way: **bots are not redirected** — crawlers get the `x-default` page so Googlebot
   (mostly US-IP) doesn't perceive `/` as "always US." Variants stay discoverable via the
   sitemap + reciprocal hreflang regardless. No more US flash: every page knows its country
   from the URL.

4. **Country-search modal.** With ~40 countries the navbar dropdown becomes a centered
   modal: a search field + flagged list (type "ger" → Germany). Selecting a country
   navigates to the same page under the new locale (`/de/en/...`), so the choice is a real,
   shareable URL — and it's "remembered" by being canonical.

5. **SEO.** The make-or-break detail is avoiding duplicate-content collapse (all variants
   are English with overlapping merchants):
   - **Reciprocal `hreflang` + `x-default`**, emitted from the **sitemap** (single source —
     cleaner than 40 `<link>` tags/page; must be reciprocal or Google ignores it).
   - **Self-referencing canonicals** — `/gb/en/x` → itself, never cross-canonical to
     `/us/en` (that would deindex the variants).
   - **Per-country `meta` / `title` / H1 + `Intl` currency** are _required_, not cosmetic —
     localized copy ("…in the UK"), £-vs-$ prices, and `Offer.priceCurrency` in structured
     data are what justify separate pages so Google ranks each market.
   - Sitemap **index** (`country × lang × page`) since the URL count grows ~40×.

6. **The region store is retired.** `region`/`useRegionStore` is replaced by the URL param
   (a `useLocale()` hook over `useParams`). The onboarding currency guess (ADR 033) reads
   the URL country instead of the store.

7. **Localization seam, front-loaded.** Even while English-only, build the seam so `/de/de`
   is later a translation drop, not a refactor:
   - **`Intl` formatting** — currency/number/date via `Intl.NumberFormat` / `DateTimeFormat`
     (kills the `$`-hardcoded spots; also feeds structured data). Centralised in Phase 1.
   - **Message keys, not inline literals** — route UI copy through a thin SSR-capable `t()`
     so translation is a JSON drop. No heavy i18n lib day one — just the discipline.
   - **Detection precedence:** URL (canonical) > saved cookie > `Accept-Language` + geo-IP >
     default. The cookie wins over geo so a UK user who _chose_ `/us` isn't bounced back.
   - **RTL stays latent** — several currencies are Arabic markets (AE/SA/EG/KW…); Tailwind
     logical properties + the `/lang` segment keep `/ae/ar` (`dir="rtl"`) a future option.

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

1. **Model + seam** — country list (`countries.ts`), `currencyOf`, the country↔merchant
   predicate, **`Intl` money/number formatting + the `t()` message seam**; unit-tested. No
   UI change.
2. **Routing shell** — `($lang).($country)` layout, `useLocale()`, `localizedHref()`, the
   `/` geo-redirect loader (origin SSR; bots get `x-default`), locale validation/404.
3. **Wire consumers** — merchant filters (home/mobile/search), the selector → modal,
   onboarding currency, all `Link`s, the choice cookie.
4. **SEO** — sitemap-level reciprocal `hreflang` + `x-default`, self-canonicals, per-country
   `meta`/H1, `Offer.priceCurrency` structured data.
5. **Cleanup** — retire `region.store.ts`; update `architecture.md` (the new loader
   exception) + docs. Cloudflare-edge redirect stays a documented future perf upgrade.

## Implementation status

Shipped across five PRs (2026-06):

- **#1401** — Phase 1: `countries.ts` model and the `i18n/` seam.
- **#1402** — Phase 2: the `:country/:lang` layout, `home-geo-redirect.tsx`, locale
  validation/404.
- **#1403 / #1404** — Phase 3: filters/search/onboarding read the URL country, the
  `CountrySelector` modal and choice cookie, and `LocaleLink` link wiring.
- **#1405** — Phase 4: per-country `hreflang` sitemap, self-canonicals, per-country titles.
- **This PR** — Phase 5: retire `region.store.ts` and `RegionSelector`; update the docs.

Two deltas from the original plan, both grounded in the live data / current feed:

- **Scope is the public catalogue + onboarding**, not literally every route. Auth/orders/
  settings/admin stay single-locale — their currency comes from the user's home-currency
  setting, not the URL, and admin is single-market ops.
- **~23 countries, not ~40**: the catalogue's live currency spread is USD/GBP/CAD/EUR, so
  the list is US + GB + CA + the full Eurozone. Per-country **merchant** sitemap pages and
  `Offer.priceCurrency` structured data are deferred until the public merchant feed carries
  country/currency (today it carries neither, so a per-country merchant page would be thin);
  the per-country **landing** pages (home + `/cashback`) ship with full reciprocal `hreflang`.

## Follow-up: country-aware merchant slugs (2026-06)

CTX is stripping country tokens from merchant **names** (`"adidas Canada"` → `"adidas"`)
while keeping the merchant's `country` field and regenerating its own brand-country slug
(`adidas-ca`). Loop derives its own slug via `merchantSlug()` in `@loop/shared`, which
originally keyed off the name alone — so the rename would have collapsed every regional
variant of a brand to the same bare slug (`adidas`) and broken `merchantsBySlug`
(last-sync-wins, the rest unreachable).

`merchantSlug()` is now **country-aware** and is the single source of truth for the slug:

1. **Prefer CTX's `slug`** (already brand-country, e.g. `adidas-ca`) — carried through the
   `mapUpstreamMerchant` mapper onto the `Merchant` record.
2. **Else derive `brandSlug(name)-<country>`** — `"adidas"` + `CA` → `adidas-ca`;
   transitional un-renamed `"adidas Canada"` + `CA` → `adidas-canada-ca` (unique, safe).
3. **Else bare `brandSlug(name)`** — data-gap fallback (no CTX slug, no country).

A separate **country-agnostic** `brandSlug(name)` export backs ADR 032 brand grouping, so
`adidas` across CA/US/GB groups into ONE brand tile (`/brand/:slug`) while each member keeps
its distinct per-merchant `merchantSlug`. The public slug-carrying responses
(`TopCashbackMerchant`, `PublicMerchantDetail`, the cashback-preview echo) now emit the
country-aware slug from the backend, so the sitemap / marketing tiles link correctly without
re-deriving from `name`. This unblocks the CTX rename without changing any pre-rename URL
(untagged merchants keep their bare slug via the fallback). See `architecture.md` →
_Backend data model_ for the runtime detail.
