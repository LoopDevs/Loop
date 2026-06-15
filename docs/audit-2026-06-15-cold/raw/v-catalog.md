# Cold Audit — Merchants / Catalog / Clustering / Public API (V6 + V7)

> Vertical: catalog sync, clustering, public API, shared merchant/grouping/slug/country
> modules, web merchant rendering. Branch `fix/stranded-order-hardening`.
> Adversarial cold read against ADR 020/021/032/033/034/035 + Part-1 dimensions.

## Coverage

Files examined in full (29):

Backend

- `apps/backend/src/merchants/sync.ts`
- `apps/backend/src/merchants/sync-upstream.ts`
- `apps/backend/src/merchants/sync-interval.ts`
- `apps/backend/src/merchants/handler.ts`
- `apps/backend/src/merchants/cashback-rate-handlers.ts`
- `apps/backend/src/clustering/algorithm.ts`
- `apps/backend/src/clustering/data-store.ts`
- `apps/backend/src/clustering/handler.ts`
- `apps/backend/src/public/geo.ts`
- `apps/backend/src/public/cashback-stats.ts`
- `apps/backend/src/public/cashback-preview.ts`
- `apps/backend/src/public/top-cashback-merchants.ts`
- `apps/backend/src/public/merchant.ts`
- `apps/backend/src/public/loop-assets.ts`
- `apps/backend/src/public/flywheel-stats.ts`
- `apps/backend/src/routes/public.ts`
- `apps/backend/src/routes/merchants.ts`
- `apps/backend/src/orders/cashback-split.ts` (cross-ref for preview parity)

Shared

- `packages/shared/src/slugs.ts` (+ `slugs.test.ts`)
- `packages/shared/src/merchant-groups.ts` (+ `merchant-groups.test.ts`)
- `packages/shared/src/merchants.ts`
- `packages/shared/src/countries.ts`
- `packages/shared/src/regions.ts`

Web

- `apps/web/app/routes/home.tsx`
- `apps/web/app/routes/brand.$slug.tsx`
- `apps/web/app/routes/gift-card.$name.tsx`
- `apps/web/app/components/features/MerchantGroupCard.tsx`
- `apps/web/app/components/features/MerchantCard.tsx` (link target only)
- `apps/web/app/services/merchants.ts`

Test-existence checked: `clustering/__tests__/{algorithm,data-store,handler}`,
`merchants/__tests__/{sync,handler}`, `public/__tests__/{cashback-preview,cashback-stats,flywheel-stats,loop-assets,merchant,top-cashback-merchants}`,
shared `slugs.test`/`merchant-groups.test`. OpenAPI registration confirmed for
all public endpoints (`openapi/public.ts`, `openapi/public-merchants.ts`,
`openapi/clusters.ts`, `openapi/merchants*.ts`); openapi-parity allowlist empty.

Not examined (deferred to other verticals / out of scope): `apps/web/app/components/features/home/*`
internals, `tools/ctx-catalog/*` operator tooling (V20), image proxy (V18),
`circuit-breaker.ts`/`upstream.ts` internals (V11/V28).

## Findings

### P1 — High

**C-01 (P1) — Brand page renders cross-country variants; country filter not applied.**
`apps/web/app/routes/brand.$slug.tsx:40,46`. The brand view groups
`useAllMerchants()` (the **full, unfiltered** catalog) and matches on the
country-agnostic `brandSlug(group.name)`. The home directory (`home.tsx:60-63`)
filters via `merchantInCountry(m, country)` _before_ grouping, so a US visitor
sees a US-scoped tile, clicks it, and lands on a brand page that lists every
regional variant (CA/GB/Eurozone members) of that brand mixed together.
Impact: ADR 034 country-scoping is violated on the brand detail page — a `/us/en`
visitor is offered CAD/GBP/EUR-priced SKUs they can't sensibly buy, and the
member count ("N gift card options") disagrees with the tile's implied scope.
Evidence: `groupMerchants(merchants)` has no `merchantInCountry` pre-filter, unlike
`home.tsx`. Fix: filter `merchants` by `merchantInCountry(m, country)` (pull
`country` from `useLocale()`) before `groupMerchants`, matching the home route.
Ref: ADR 034 §Decision-2.

### P2 — Medium

**C-02 (P2) — `cashback-preview` / `public/merchant` echo the slug as `merchantId`, not the requested id.**
`public/cashback-preview.ts:187-206` returns `merchantId: resolved.slug`, and the
shape comment (lines 13-18) documents `merchantId: "amazon-us"` (a slug). When a
caller passes a real CTX id (`?merchantId=<ctx-id>`), the response echoes the
_slug_ instead, so a client correlating request→response by id sees a mismatch.
`public/merchant.ts` returns both `id` (real id) and `slug` separately, which is
cleaner. Impact: contract ambiguity / brittle client correlation; not a security
issue (no PII). Fix: either rename the preview field to `slug` or echo the
resolved `id`; align with the OpenAPI schema in `openapi/public-merchants.ts`.

**C-03 (P2) — `merchantsBySlug` slug-collision is silently lossy under same-brand+same-country dupes.**
`merchants/sync.ts:199-216`. On a true duplicate (same brand AND country, no CTX
slug — the documented ~8 `lastminute`-class clusters), the _later_ merchant wins
and the earlier one becomes unreachable by slug (`/by-slug/:slug`,
`/gift-card/:name`, `public/merchant`, `public/cashback-preview` all resolve to
the survivor only). It is logged (warn), but there is no deterministic tie-break
(e.g. prefer enabled / higher locationCount), so which dupe wins depends on
upstream page order and can flip between syncs — meaning a user's bookmarked
gift-card URL can silently resolve to a _different_ merchant after a refresh.
Impact: non-deterministic catalog routing for the dupe set. Fix: deterministic
tie-break (stable sort by id) so the survivor is stable across syncs, and/or
suffix the loser's slug. Ref: ADR 021 (catalog integrity) / ADR 032.

**C-04 (P2) — `cashback-preview` bps conversion uses float `Math.round`, not exact string parse like the order path.**
`public/cashback-preview.ts:96-99` (`cashbackPctToBps`) does
`Math.round(Number(pct) * 100)`, whereas the authoritative order-insert path
(`orders/cashback-split.ts:applyPct`) parses the `numeric(5,2)` string exactly.
For all real 2-decimal configs the results match, but the preview's stated
contract ("never promises more than the user will actually earn") rests on
float arithmetic that can diverge by 1 bp on adversarial/edge pct strings the
DB could theoretically hold. Impact: low (DB column is `numeric(5,2)`, bounded),
but it is a _second, independent_ implementation of money math that can drift
from the source of truth. Fix: reuse/share the exact-string `applyPct` rounding.
Ref: checklist §25 (no duplicate money math), §1 (numeric correctness).

**C-05 (P2) — `merchantInCountry` country/currency asymmetry can over-show extended-market merchants.**
`packages/shared/src/countries.ts:163-176`. Country match reads top-level
`merchant.country`; currency match reads `merchant.denominations?.currency`. A
merchant with neither field stays visible **everywhere**, including the ADR-035
extended-market country pages (AE/IN/SA/AU/MX). The comment claims "no such rows
exist in the live catalogue", but the in-flight domains/media content pass is
actively mutating catalog rows, and a sync gap that drops `denominations` on a
USD merchant would leak it into every country grid. Impact: weak data-gap
fallback on a surface ADR 035 just expanded. Fix: tighten the fallback (default
to display in DEFAULT_COUNTRY only, or require an explicit currency) once the
content pass settles. Ref: ADR 034 §Decision-2, ADR 035.

### P3 — Low

**C-06 (P3) — `geo.ts` Cache-Control is per-IP-result but `private, max-age=600` may cache a stale guess across a CGNAT/VPN switch.** `public/geo.ts:36`. Minor; the
selector is overridable. No-PII posture is correct (IP never echoed/logged).

**C-07 (P3) — No test for `public/geo.ts`.** Every other public handler has a
`__tests__` file; `geo.ts` (MaxMind reader lazy-open, null-DB fallback,
`clientIpFor` integration, never-500) has none. The fallback-to-DEFAULT_REGION
path and the reader-open-failure path are untested. Ref: checklist §12.

**C-08 (P3) — Clustering date-line (west > east) silently returns empty.**
`clustering/handler.ts:52-54` + `algorithm.ts`. Documented as a known limitation
(comment), but antimeridian-crossing viewports (Pacific) get an empty map with no
client signal. Acceptable for Phase 1; flag for completeness. No test asserts the
documented empty behaviour. Ref: checklist §13 (algorithmic complexity).

**C-09 (P3) — `regions.ts` retained as a partial dependency after ADR 034 Phase 5.**
`packages/shared/src/regions.ts` is marked "Superseded" but `geo.ts` still depends
on `regionForCountry`/`DEFAULT_REGION` to populate the vestigial
`GeoResponse.region`. Dead-ish field carried for back-compat; track for removal so
the two country/region models don't drift. Ref: checklist §5, §12 dead-code sweep.

## Positives (no action)

- Never-500 discipline (ADR 020) is uniformly applied across every public handler:
  try/catch + last-known-good snapshot (`cashback-stats`, `top-cashback-merchants`,
  `merchant`, `flywheel-stats`) or safe-empty (`loop-assets`, `geo`,
  `cashback-rate-handlers`), with `max-age=60` on the degraded path and 300 on happy.
- Atomic store replacement in both syncs (whole-object swap, no partial-page
  windows); `loadedAt: 0` bootstrap so /health reports stale until first success;
  denylist snapshotted once per refresh (no mid-refresh half-apply);
  `isMerchantRefreshing`/`isLocationRefreshing` coalesce concurrent refreshes;
  `forceRefreshMerchants` rethrow vs background swallow split is correct.
- All upstream responses Zod-validated; per-record `safeParse` so one malformed
  merchant/location doesn't poison the page; MAX_PAGES ceilings; 30s AbortSignal
  timeouts; size caps on every string field (`sync-upstream.ts`).
- Clustering: invGridSize reciprocal trick (float-exact cell keys), NaN/Infinity
  coord rejection, globe-clamped bbox expansion, `pointCount` = full cell
  membership while centroid uses visible-only (tested), protobuf v2 create/toBinary
  path correctly fixed (A4-115) with `Vary: Accept`. Strong test coverage.
- Input validation tight on every public param (merchant-id regex + length cap,
  amountMinor integer-only + bigint range, clusters finite + globe-range guards).
- ADR 032 grouping is reversible (client-side derivation, `group`-named field, key
  off brand prefix) and country-agnostic by design; per-member links stay
  country-aware via `merchantSlug` — tested end to end.
- Web rendering degrades gracefully on missing media (logo/card-image fallbacks to
  initial-letter blocks); descriptions/terms/instructions rendered as plain text /
  `whitespace-pre-wrap` — no `dangerouslySetInnerHTML`, no XSS surface from CTX
  content.
- Top-cashback + public-merchant correctly drop catalog-evicted config rows
  (ADR 021 Rule B); numeric cast on the ORDER BY prevents lexicographic rate sort.

## Summary

| Severity | Count |
| -------- | ----- |
| P0       | 0     |
| P1       | 1     |
| P2       | 4     |
| P3       | 4     |

Vertical is in good shape: never-500, atomic sync, Zod validation, clustering
correctness, and grouping reversibility are all solid and well-tested. The one
P1 is a real ADR-034 scoping miss on the brand detail page (cross-country variant
leak). The P2s are contract/determinism/data-gap edges, not money-loss or
security. No P0s — no auth bypass, no PII leakage, no ledger exposure on the
public surface.
