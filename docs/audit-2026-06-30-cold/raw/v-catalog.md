# Vertical Merchants/catalog — raw findings

Files examined: 19/19 assigned + 9 test siblings + 8 cross-referenced
(shared/public/root) files read to verify claims. Full list in
**Coverage confirmation** below.

## Findings

### CAT-01 [P1 · LIVE] Cold-started / autoscaled backend serves an empty merchant+location+cluster catalog to real users, and `/health` doesn't stop it

- File: `apps/backend/src/health.ts:183-213`, `apps/backend/src/index.ts:75-81,210`,
  `apps/backend/fly.toml` (`auto_stop_machines`/`auto_start_machines`/`[[http_service.checks]]`),
  `apps/backend/src/merchants/sync.ts:64-69,217`, `apps/backend/src/clustering/data-store.ts:54,170`
- Description: `startMerchantRefresh()` / `startLocationRefresh()` are fire-and-forget
  (`void refreshMerchants()`); `serve()` (index.ts:210) starts accepting HTTP
  traffic without waiting for the first sync to finish. The merchant/location
  stores start as `{ merchants: [], loadedAt: 0 }` / `{ locations: [], loadedAt: 0 }`
  and are only assigned once, atomically, at the END of the full pagination
  loop — so for however long the first sync takes (multiple sequential
  upstream page fetches), `/api/merchants/all`, `/api/merchants`, and
  `/api/clusters` all return empty, valid-looking 200 responses (`{merchants:
[], total: 0}` / `{locationPoints: [], clusterPoints: []}`). `/health`
  (`health.ts:211-213`) only classifies _DB unreachable_ or a _degraded
  worker_ as `criticalDegraded` (503, the only status that makes Fly cycle
  the machine / not yet count it healthy). `merchantsStale`/`locationsStale`
  (true for any machine with `loadedAt === 0`) are bucketed under
  `softDegraded`, which still returns HTTP 200. Fly's `[[http_service.checks]]`
  hits `/health` and is satisfied by 200, so a brand-new machine is routed
  live traffic while its catalog is still empty.
  `fly.toml` has `auto_stop_machines = "stop"` + `auto_start_machines = true`
  with a 200-request soft concurrency limit — so this isn't a once-a-quarter
  edge case: every deploy creates fresh machines from cold, and every
  traffic-driven autoscale-out event spins up a new machine that immediately
  receives directed requests while cold.
  Compounding consequence on web: `apps/web/app/root.tsx:167-180` prefetches
  `/api/merchants/all` on every page load and unconditionally persists
  whatever it gets to `localStorage['loop_merchants_all_v1']` with a 24h TTL —
  there is no check that `data.merchants.length > 0` before caching. A visitor
  unlucky enough to load during the empty-catalog window gets that empty
  result written to their device's cache, so the home directory looks broken
  ("All merchants" header over an empty grid, no error state) for up to 24h
  or until their next visit happens to land past the 30-minute TanStack
  `staleTime` and trigger a corrective refetch.
- Impact: Real users — on a normal deploy, not just an incident — can load
  the home page, map, or gift-card directory and see "no merchants" with no
  loading/error affordance (TanStack's `isLoading` has already resolved to
  `false` once the empty 200 lands). This directly contradicts the "Atomic
  store replacement... no partial-page windows" invariant the prior audit
  credited the sync with — the atomicity is real, but it concentrates the
  empty-to-full transition into one large window at every cold boot, and
  nothing gates traffic away from a machine still inside that window.
- Evidence: `index.ts:75-81` (`startMerchantRefresh()` not awaited),
  `index.ts:210` (`serve()` runs immediately after), `health.ts:183-213`
  (`softDegraded` = 200, `criticalDegraded` = 503; merchant/location
  staleness only ever contributes to `softDegraded`), `fly.toml`
  (`auto_stop_machines = "stop"`, `auto_start_machines = true`,
  `hard_limit = 250` / `soft_limit = 200` concurrency triggers autoscale-out,
  health check has no readiness semantics distinct from liveness),
  `root.tsx:167-180` (`localStorage.setItem` with no non-empty guard).
- Minimal fix: in `health.ts`, treat a **never-yet-loaded** catalog
  (`merLoadedAt === 0` or `locLoadedAt === 0`, distinct from a _stale-after-
  having-loaded_ catalog) as `criticalDegraded` so `/health` returns 503
  until the first sync completes — Fly's grace period (30s) and check
  interval (15s) already exist for exactly this purpose, they're just not
  wired to this condition. Pair with a `data.merchants.length > 0` guard
  before `root.tsx` writes to `localStorage`.
- Better fix: separate liveness from readiness explicitly — add a
  `/ready` endpoint that's 503 until `merchants.length > 0 && locations.length
  > 0`(or accept a slightly degraded map-only ready state if locations lag
merchants by design — they already start 3s apart), point Fly's`[[http_service.checks]]`at it, and keep`/health`as the looser
liveness/observability surface it already is. Consider`await`-ing the
first `refreshMerchants()`(with a bounded timeout, e.g. 10-15s) before`serve()` so the common case never even exercises the gap, falling back to
  > the readiness-gate behavior only when upstream is slow.

### CAT-02 [P1 · LIVE] CF-31's country-scoping fix is incomplete — `/calculator` (live today), `/cashback`, `/cashback/:slug` render the catalog with zero country awareness

- File: `apps/web/app/routes/calculator.tsx:43-107`, `apps/web/app/routes/cashback.tsx:57-119`,
  `apps/web/app/routes/cashback.$slug.tsx:88-157`, `apps/backend/src/public/top-cashback-merchants.ts:55-86`,
  `apps/backend/src/public/merchant.ts:67-78`, `apps/web/app/components/features/cashback/CashbackCalculator.tsx:113-115`
- Description: CF-31 fixed exactly one surface (`brand.$slug.tsx`) by adding
  a `merchantInCountry()` pre-filter before grouping, matching `home.tsx`'s
  existing pattern. But three other catalog-rendering routes were never
  touched and have **no country parameter anywhere in the chain** — not a
  missing frontend filter (which would be a one-line fix), but a genuine gap
  in the backend contract: `GET /api/public/top-cashback-merchants` and
  `GET /api/public/merchants/:id` accept no `country`/`currency` argument and
  always rank/return across the **entire global catalog**. `calculator.tsx`
  and `cashback.tsx` both call `getPublicTopCashbackMerchants({ limit })`
  with no locale info at all; `cashback.$slug.tsx` resolves any slug
  regardless of the visitor's country.
  `calculator.tsx` is reachable both unprefixed (`/calculator`) and under the
  locale layout (`/:country/:lang/calculator` — see `routes.ts:34`) and is
  **not** wrapped in `Phase2Gate`, unlike `cashback.tsx`/`cashback.$slug.tsx`.
  Cashback configs are not exclusively a Phase-2 concept — `gift-card.$name.tsx`
  unconditionally renders a "Cashback" badge tile whenever a merchant has an
  active `merchant_cashback_configs` row (no Phase gate on that tile), which
  means admins can and do configure cashback rates during Phase 1. So
  `/calculator`'s country-blind merchant picker is live, production
  behavior today, not a dormant Phase-2 path.
  Downstream UX: `CashbackCalculator.tsx:113-115` hardcodes a literal `"$"`
  next to the amount input regardless of which merchant is selected — so even
  though the _output_ correctly formats in `data.currency` via
  `Intl.NumberFormat`, a non-USD merchant picked from the country-blind
  dropdown shows "$50 → [output in their real currency]", actively
  mislabeling the input.
- Impact: A `/gb/en/calculator` or `/gb/en/cashback` visitor sees the exact
  same global top-N list a `/us/en` visitor sees, including merchants tagged
  to CA/AE/IN/SA/AU/MX (ADR 035 extended markets) that GB doesn't serve or
  doesn't price in GBP. Clicking through ("Shop X gift cards" on
  `cashback.$slug.tsx:199-204`) lands on `gift-card.$name.tsx`, which (by
  design, since it resolves a specific country-aware slug directly) doesn't
  re-validate the merchant against the visitor's locale either — so a visitor
  can walk the entire funnel up to checkout for a merchant whose currency
  isn't orderable in their market, only discovering the mismatch at
  order-submit time via CF-19/ADR-035's `CURRENCY_NOT_AVAILABLE`. This is the
  exact bug class CF-31 just fixed on `brand.$slug.tsx`, reappearing
  unaddressed on three sibling surfaces — the underlying root cause (country
  scoping bolted onto the frontend ad hoc, per-route, with no shared backend
  contract) was not actually fixed, only its single most-visible symptom was.
- Evidence: `routes.ts:30-39` (calculator mounted both legacy + locale-prefixed,
  no `Phase2Gate` import in `calculator.tsx` vs. explicit `<Phase2Gate>` wrap
  in `cashback.tsx:49-55` / `cashback.$slug.tsx:80-86`); `top-cashback-merchants.ts:55-86`
  `compute()` has no country/currency parameter in its signature or its SQL;
  `public/merchant.ts:67-78` `resolveMerchant()` likewise; the existing test
  `apps/web/app/routes/__tests__/calculator.test.tsx` only ever exercises
  `-us`-suffixed merchant ids and never asserts on locale at all, confirming
  no one wrote a country-scoping test because there's no country-scoping
  code to test.
- Minimal fix: add an optional `?country=` query param to
  `GET /api/public/top-cashback-merchants` and `GET /api/public/merchants/:id`,
  filter server-side with the same `merchantInCountry()` semantics already
  used by the web (port it from `@loop/shared` or call it directly — it's
  pure and already shared-package-resident), and pass `useLocale().country`
  through from `calculator.tsx` / `cashback.tsx` / `cashback.$slug.tsx`. Fix
  the hardcoded `"$"` in `CashbackCalculator.tsx` to use
  `currencySymbol(merchant.currency, locale)` the way `gift-card.$name.tsx`
  already does for denominations.
- Better fix: centralize country-scoped catalog filtering as a single backend
  capability (one query-time filter function reused by every `public/*.ts`
  handler) rather than re-deriving the `merchantInCountry` pattern per-route
  on the frontend each time a new catalog surface ships — this is the third
  time (home, brand, and now calculator/cashback) the same filter has had to
  be independently remembered. Also wire `gift-card.$name.tsx` to surface a
  non-blocking "this gift card isn't orderable in your region" notice (using
  the already-existing `merchantInCountry` check) before the user invests
  time in `PurchaseContainer`, instead of only failing at order-submit.

### CAT-03 [P3 · LIVE] Brand page slug match is case-sensitive, unlike every sibling slug lookup in the codebase

- File: `apps/web/app/routes/brand.$slug.tsx:39,54-57`
- Description: `const { slug = '' } = useParams<{ slug: string }>()` is used
  verbatim in `groupMerchants(countryMerchants).find((g) => brandSlug(g.name)
=== slug)`. `brandSlug()` always lowercases its output, but the raw URL
  `slug` is never lowercased (or run through `brandSlug()` itself) before the
  `===` comparison. Every other slug-resolution path in the codebase is
  explicitly case-insensitive and says so in a comment:
  `apps/backend/src/merchants/handler.ts:107-110` ("Accept a case-insensitive
  match so a hand-typed URL like `/by-slug/Target` still resolves instead of
  404'ing").
- Impact: `/brand/Adidas` (or any differently-cased variant from an old
  backlink, a manually-typed URL, or a search-engine-indexed mixed-case URL)
  renders "Brand not found" even though the brand exists and
  `/brand/adidas` works. Low severity (cosmetic 404, no data risk) but a
  real, user-visible inconsistency with the documented case-insensitivity
  convention elsewhere.
- Evidence: `brand.$slug.test.tsx` never exercises a mixed-case slug — every
  test calls `renderAt(merchantSlug('dots.eco'))`, which is already
  lowercase by construction.
- Minimal fix: `brandSlug(g.name) === slug.toLowerCase()`.
- Better fix: run the raw param through `brandSlug()` itself before
  comparing (`brandSlug(decodeURIComponent(slug)) === brandSlug(g.name)`),
  matching the same lowercase-and-sanitize treatment used everywhere else a
  slug is compared, so a stray trailing space or odd casing from a hand-typed
  URL also resolves instead of 404ing.

### CAT-04 [P2 · LIVE · carried forward, re-confirmed] `cashback-preview` echoes the slug as `merchantId`, not the requested id

- File: `apps/backend/src/public/cashback-preview.ts:184-191,207-214`
- Description: Independently re-derived while reading this file (per the
  task's instruction to verify unaddressed 06-15 items) before consulting
  the prior audit — confirms 06-15's C-02. `resolveMerchant()` returns
  `slug: merchantSlug(m)`, and both the soft-fail and happy-path responses
  set `merchantId: resolved.slug`. A caller that passes a real CTX id
  (`?merchantId=<ctx-id>`) gets back a **slug** in the `merchantId` field —
  the JSDoc shape comment (lines 13-18) even documents `merchantId:
"amazon-us"` as the expected value, contradicting the parameter name. This
  file is unchanged in the 22-commit delta (not in the changed-files list in
  `delta-manifest.md`), so the gap is exactly where 06-15 left it.
- Impact: Contract ambiguity for any client correlating request → response
  by id; not a security issue (no PII, no authz implication).
- Evidence: `cashback-preview.ts:206-213` and `:225-231` both echo
  `resolved.slug`, never `resolved.id`.
- Minimal fix: rename the field to `slug` (it's already a slug — call it
  one), or echo `resolved.id` instead and add `slug` as a separate field
  (matching `public/merchant.ts`'s cleaner `{ id, slug }` split).
- Better fix: same as minimal — align with `public/merchant.ts`'s existing
  `{ id, slug }` shape so the two public merchant-adjacent endpoints share
  one contract pattern instead of two.

### CAT-05 [P2 · LIVE · carried forward, re-confirmed] `merchantsBySlug` same-brand+country dupes resolve non-deterministically across syncs

- File: `apps/backend/src/merchants/sync.ts:199-216`
- Description: Re-confirmed independently (06-15's C-03). On a true
  duplicate (same brand AND same country, no CTX-provided slug — the
  documented `lastminute`-class clusters), the build loop
  (`for (const m of merchants) { ...; merchantsBySlug.set(slug, m); }`) lets
  whichever record appears **later in upstream's page order** win; the
  earlier one becomes unreachable by slug. It's logged at `warn` level
  (`sync.ts:203-213`, also exercised by the
  `'warns only on a TRUE duplicate'` test in `sync.test.ts:512-534`), but
  there's no deterministic tie-break (e.g. stable sort by id, or prefer
  `enabled && higher locationCount`), so the winner can flip between two
  consecutive refreshes purely because upstream changed its internal page
  ordering — meaning a bookmarked `/gift-card/lastminute-gb` URL can
  silently start resolving to a _different_ merchant after the next 6-hourly
  sync, with no user-visible signal that anything changed.
- Impact: Non-deterministic catalog routing for the (small, ~8-cluster) dupe
  set; not money-loss, but a real correctness/stability gap on a bookmarked,
  potentially-shared URL.
- Evidence: `sync.ts:199-216`; `sync.test.ts:512-534` pins the _current_
  last-write-wins behavior as expected, rather than asserting a stable
  winner — i.e. the test documents the non-determinism rather than guarding
  against it.
- Minimal fix: sort `merchants` by `id` (or another stable, upstream-
  independent key) before the `merchantsBySlug` build loop so the same
  `(brand, country)` pair always produces the same winner run-to-run,
  independent of upstream's page order.
- Better fix: same stable sort, plus suffix the loser's slug (e.g.
  `lastminute-gb-2`) instead of dropping it silently, so both merchants stay
  reachable and the operator-facing warn becomes purely informational rather
  than "data has silently become unreachable."

### CAT-06 [P2 · LIVE · carried forward, re-confirmed] `cashback-preview` bps conversion uses float `Math.round`, a second independent implementation of money math

- File: `apps/backend/src/public/cashback-preview.ts:96-99` (`cashbackPctToBps`)
- Description: Re-confirmed independently (06-15's C-04).
  `Math.round(Number(pct) * 100)` converts the `numeric(5,2)` percentage
  string via float arithmetic, while the authoritative order-insert path
  (`orders/cashback-split.ts`, cross-referenced, not in this vertical's
  scope but the comment at `cashback-preview.ts:18-23` explicitly claims
  parity with it: "Cashback math matches `orders/cashback-split.ts`") parses
  the same numeric string exactly via string/bigint arithmetic. For every
  real 2-decimal-place config in the DB (`numeric(5,2)` bounds the input),
  the float and exact paths agree — but the preview endpoint's own stated
  contract ("the preview never promises more than the user will actually
  earn") is being upheld by two structurally different implementations that
  happen to agree today rather than by construction.
- Impact: Low under current `numeric(5,2)` constraints; latent risk if the
  column's precision/scale ever widens, or if a future caller feeds this
  function a string outside the DB's bounded shape.
- Evidence: `cashback-preview.ts:96-99` vs. the file's own header comment at
  lines 18-23 asserting parity with `orders/cashback-split.ts`'s exact
  arithmetic.
- Minimal fix: extract the exact-string rounding helper from
  `orders/cashback-split.ts` into a shared module (or `@loop/shared`) and
  have `cashbackPctToBps` call it, removing the float path entirely.
- Better fix: same — single shared implementation, used by both the
  authoritative order-insert path and the preview, so "matches
  `cashback-split.ts`" is true by construction instead of by coincidence of
  current data bounds.

### CAT-07 [P2 · LIVE · carried forward, re-confirmed] `merchantInCountry`'s data-gap fallback shows an untagged merchant on every country page

- File: `packages/shared/src/countries.ts:152-176`
- Description: Re-confirmed independently (06-15's C-05) while reading this
  file to assess CF-31's fix. `merchantInCountry()` reads top-level
  `merchant.country` for the country match and `merchant.denominations?.currency`
  for the currency match; a merchant with **neither** field set returns
  `true` for every country, i.e. shows up on every locale-scoped directory
  page (`home.tsx`, and now `brand.$slug.tsx` post-CF-31). The comment at
  lines 159-161 says "No such rows exist in the live catalogue, but the
  guard keeps a future sync gap from silently hiding a brand" — but the
  practical effect of the chosen fallback is the _opposite_ framing: it's a
  silent **over-show**, not a silent hide, and the active
  `tools/ctx-catalog` media/content pass (per
  `project_ctx_media_pipeline` memory) is mutating live catalog rows on an
  ongoing basis, so the "no such rows exist" premise is exactly the kind of
  assumption that erodes over time without anyone noticing until a US
  visitor sees an AE-only or India-only merchant with no `country`/`currency`
  tag mixed into their directory grid.
- Impact: Weak data-gap fallback on a surface ADR 035 just expanded
  (5 new extended-market countries). Not a security issue; a catalog-
  correctness one.
- Evidence: `countries.ts:171` (`if (!merchantCountry && !merchantCurrency)
return true;`).
- Minimal fix: flip the fallback to default to `DEFAULT_COUNTRY` only (so an
  untagged merchant shows in `US` and nowhere else) rather than everywhere,
  once the in-flight content pass settles and an operator can confirm no
  live rows currently depend on the "everywhere" behavior.
- Better fix: same, plus a periodic operator alert (Discord notifier, same
  pattern as the merchant slug-collision warn) when a sync produces a
  merchant with neither `country` nor `denominations.currency` set, so a
  data-gap is caught and fixed upstream instead of silently leaning on this
  fallback indefinitely.

### CAT-08 [P3 · LIVE] Zero unit-test coverage on four of six in-scope route components

- File: `apps/web/app/routes/gift-card.$name.tsx`, `apps/web/app/routes/map.tsx`,
  `apps/web/app/routes/cashback.tsx`, `apps/web/app/routes/cashback.$slug.tsx`
- Description: None of these four route components has a corresponding
  `__tests__/*.test.tsx` file (confirmed via `find` against
  `apps/web/app/routes/__tests__/`), unlike `brand.$slug.tsx` and
  `calculator.tsx`, which both do. `gift-card.$name.tsx` is the actual
  purchase-conversion entry point (505 lines, substantially changed per this
  audit's delta manifest) — its description-paragraph-splitting regex
  (`:448-458`), mobile/desktop layout branching, and denomination-display
  branches (fixed vs. min-max) are exercised only by the mocked/real e2e
  purchase-flow suites (`tests/e2e-mocked/purchase-flow.test.ts`,
  `tests/e2e/purchase-flow.test.ts`) at a coarse, happy-path level — not at
  the unit level where edge cases (empty description, `\r\n\r\n` line
  endings, missing logo/card image, zero-value `savings`) would normally be
  pinned.
- Impact: Lower confidence on edge-case regressions in the highest-traffic
  conversion page; not a correctness bug today, a coverage gap.
- Evidence: `find apps/web/app/routes/__tests__ -iname "gift-card*"` /
  `-iname "map*"` / `-iname "cashback*"` all return empty; e2e greps
  (`grep -rl "gift-card" tests/e2e*`) only match `purchase-flow.test.ts`.
- Minimal fix: add a focused unit test for `gift-card.$name.tsx`'s
  description-paragraph-splitting and denomination-rendering branches at
  minimum, since those are the most edge-case-prone, least e2e-covered
  logic in the file.
- Better fix: bring all four route components up to the same
  component-test bar as `brand.$slug.tsx`/`calculator.tsx` (mock
  `use-merchants`/`use-native-platform`, render via `MemoryRouter`, assert
  on loading/error/empty/happy states) — the pattern is already established
  in this same directory, just not applied uniformly.

## Delta re-verification

**CF-31 `brand.$slug.tsx` country-scoping — verdict: genuinely fixed, correctly implemented.**

`apps/web/app/routes/brand.$slug.tsx:44,50-57` now computes
`countryMerchants = merchants.filter((m) => merchantInCountry(m, country))`
(reading `country` from `useLocale()`) and groups _that_ filtered set
(`groupMerchants(countryMerchants).find((g) => brandSlug(g.name) === slug)`),
exactly mirroring `home.tsx:57-63`'s established pattern. The brand-group
_key_ correctly stays country-agnostic (`brandSlug(group.name)`, so
`/brand/adidas` still resolves the same URL across markets) while the
_members listed_ are now scoped to the active country — verified by reading
both files side-by-side and by `brand.$slug.test.tsx`'s existing "does not
surface an unrelated brand" test (though that test doesn't specifically
exercise cross-country filtering — it would be worth adding a country-aware
case, e.g. a CA-only and US-only same-brand member, asserting only the
locale-matching one renders). The original C-01 finding (cross-country
variant leak: a `/us/en` visitor seeing CAD/GBP/EUR-priced SKUs on a brand
page) is closed.

**However, CF-31 was a point fix, not a systemic one** — see **CAT-02**
above: the same class of bug (catalog content rendered without country
scoping) is still present, unaddressed, on `/calculator` (live, ungated),
`/cashback`, and `/cashback/:slug` (Phase-2-gated, but will reproduce
identically the day `LOOP_PHASE_1_ONLY` flips to `false` unless fixed before
then). The root cause — country filtering implemented ad hoc per-route on
the frontend, with no backend-level country parameter on the
`/api/public/*` catalog endpoints — was not addressed by CF-31, only its
single most user-visible symptom was.

## Coverage confirmation

Backend (9 files, all read in full):

- `apps/backend/src/merchants/cashback-rate-handlers.ts`
- `apps/backend/src/merchants/handler.ts`
- `apps/backend/src/merchants/sync-interval.ts`
- `apps/backend/src/merchants/sync-upstream.ts`
- `apps/backend/src/merchants/sync.ts`
- `apps/backend/src/clustering/algorithm.ts`
- `apps/backend/src/clustering/data-store.ts`
- `apps/backend/src/clustering/handler.ts`
- `apps/backend/src/routes/merchants.ts`

Backend `__tests__` siblings (read in full):

- `apps/backend/src/merchants/__tests__/sync.test.ts`
- `apps/backend/src/merchants/__tests__/handler.test.ts` (also exercises
  `cashback-rate-handlers.ts` and `routes/merchants.ts` via `app.request()`)
- `apps/backend/src/clustering/__tests__/algorithm.test.ts`
- `apps/backend/src/clustering/__tests__/data-store.test.ts`
- `apps/backend/src/clustering/__tests__/handler.test.ts`
- (no dedicated test file exists for `sync-interval.ts` or
  `sync-upstream.ts` — both are exercised indirectly through `sync.test.ts`;
  acceptable given their thin scheduling/parsing-only surface)

Web (10 files, all read in full):

- `apps/web/app/routes/brand.$slug.tsx`
- `apps/web/app/routes/gift-card.$name.tsx`
- `apps/web/app/routes/map.tsx`
- `apps/web/app/routes/calculator.tsx`
- `apps/web/app/routes/cashback.tsx`
- `apps/web/app/routes/cashback.$slug.tsx`
- `apps/web/app/services/merchants.ts`
- `apps/web/app/services/clusters.ts`
- `apps/web/app/services/favorites.ts`
- `apps/web/app/services/recently-purchased.ts`

Web `__tests__` siblings (read in full where present; absence confirmed via
`find` otherwise):

- `apps/web/app/routes/__tests__/brand.$slug.test.tsx` (read)
- `apps/web/app/routes/__tests__/calculator.test.tsx` (read)
- `apps/web/app/routes/__tests__/gift-card.$name.test.tsx` — **does not exist** (CAT-08)
- `apps/web/app/routes/__tests__/map.test.tsx` — **does not exist** (CAT-08)
- `apps/web/app/routes/__tests__/cashback.test.tsx` — **does not exist** (CAT-08)
- `apps/web/app/routes/__tests__/cashback.$slug.test.tsx` — **does not exist** (CAT-08)
- `apps/web/app/services/__tests__/merchants.test.ts` (read)
- `apps/web/app/services/__tests__/clusters.test.ts` (read)
- `apps/web/app/services/__tests__/favorites.test.ts` (existence confirmed; non-vacuous on skim)
- `apps/web/app/services/__tests__/recently-purchased.test.ts` (existence confirmed; non-vacuous on skim)

Cross-referenced (read in full to verify claims about CF-31, country
scoping, grouping/slug correctness, and the cold-start finding — not graded
as this vertical's primary files, but necessary to substantiate the
findings above):

- `apps/web/app/routes/home.tsx` (country-filter reference pattern)
- `apps/web/app/hooks/use-merchants.ts`
- `apps/web/app/components/features/FavoritesStrip.tsx`
- `apps/web/app/components/features/cashback/CashbackCalculator.tsx`
- `apps/web/app/components/Phase2Gate.tsx`
- `apps/web/app/routes.ts`
- `apps/web/app/i18n/locale.ts`
- `apps/web/app/routes/locale-layout-ssr.tsx`
- `apps/web/app/routes/__tests__/calculator.test.tsx`
- `apps/web/app/root.tsx` (localStorage catalog cache)
- `packages/shared/src/merchants.ts`
- `packages/shared/src/slugs.ts`
- `packages/shared/src/merchant-groups.ts`
- `packages/shared/src/countries.ts`
- `apps/backend/src/public/top-cashback-merchants.ts`
- `apps/backend/src/public/merchant.ts`
- `apps/backend/src/public/cashback-preview.ts`
- `apps/backend/src/health.ts`
- `apps/backend/src/index.ts` (boot sequencing)
- `apps/backend/fly.toml` (autoscale/health-check config)

Also consulted per the task brief: `docs/audit-2026-06-30-cold/checklist.md`,
`docs/audit-2026-06-15-cold/checklist.md`, `docs/audit-2026-06-30-cold/delta-manifest.md`,
and (after forming independent judgment) `docs/audit-2026-06-15-cold/raw/v-catalog.md`
to check the three named unaddressed P2/P3 items — all three (cashback-preview
slug echo, non-deterministic dupe resolution, float bps rounding) were
independently re-derived from the code before cross-checking, and are
re-confirmed open as CAT-04/CAT-05/CAT-06 above.
