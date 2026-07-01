# Vertical Public API — raw findings

Files examined: 16/16 (10 required scope files + 6 test files, full reads).
Plus 7 `@loop/shared` type files and `middleware/rate-limit.ts` /
`merchants/sync.ts` / `db/schema.ts` / migration 0036 consulted for
cross-file verification (parity, index coverage, never-throw proof).

## Never-500 trace

For every handler: every throw/error path traced, with the catch boundary
that converts it to a safe response.

**`cashback-preview.ts` (`publicCashbackPreviewHandler`)**

- `c.req.query()` reads — never throw.
- `BigInt(amountRaw)` — wrapped in its own `try/catch` → 400 `VALIDATION_ERROR`.
- `resolveMerchant()` — pure `Map.get`, never throws → 404 on miss.
- `db.select(...).limit(1)` — wrapped in `try/catch` → soft-empty 200
  (`cashbackPct: null, cashbackMinor: '0'`), `max-age=60`.
- `cashbackPctToBps` / `previewCashbackMinor` — pure, total functions, no throw
  for any input in range.
- `c.json(...)` — only ever passed strings/numbers/null, never a raw `bigint`
  (all bigints `.toString()`-ed first) → no `JSON.stringify` TypeError.
- **Verdict: never-500 holds.** Every external-input-dependent step is guarded.

**`cashback-stats.ts` (`publicCashbackStatsHandler`)**

- TTL-memo fast path (`cache !== null && fresh`) — pure object read, no throw.
- `computeStats()` (3 × `db.execute`, now `Promise.all`'d) — wrapped in
  `try/catch` → on throw, serves `cache.value` (last-known-good) if present,
  else a zeroed bootstrap snapshot. `max-age=60` on both fallback branches.
- `toNumber` / `toStringBigint` / `rowsOf` — defensive, handle string/number/
  bigint/array/`{rows}` driver-shape variance, no throw.
- **Verdict: never-500 holds.**

**`flywheel-stats.ts` (`publicFlywheelStatsHandler`)**

- Entire body (query + arithmetic + response) wrapped in one `try/catch`.
- `toFixed(1)` on a `number` — never throws.
- Catch branch serves `lastKnownGood ?? FALLBACK_ZERO`, `max-age=60`.
- **Verdict: never-500 holds.**

**`geo.ts` (`publicGeoHandler`)**

- `geoReader()` — internally `.catch(() => null)`s the `open()` rejection, so
  it never rejects; additionally the handler's own `try/catch` covers the
  `await geoReader()` + `reader.get(clientIpFor(c))` call. `clientIpFor(c)` is
  called _inside_ the try, not before it.
- `regionForCountry()` — pure lookup with `?? DEFAULT_REGION` fallback, never
  throws regardless of what MaxMind returns.
- **Verdict: never-500 holds**, but see PUB-04/PUB-05 (zero test coverage,
  silent failure mode).

**`loop-assets.ts` (`publicLoopAssetsHandler`)**

- `configuredLoopPayableAssets()` — verified pure/sync (no I/O) in
  `credits/payout-asset.ts:80-92`; wrapped in `try/catch` anyway → empty list,
  `max-age=60`, on any future regression that adds I/O.
- **Verdict: never-500 holds.**

**`merchant.ts` (`publicMerchantHandler`)**

- Validation (`idParam` undefined/empty/malformed) → 400, **before** any
  try/catch — fine, can't throw, but see PUB-06 (no Cache-Control on this
  path).
- `resolveMerchant()` → 404 on miss, same caveat as above.
- `compute()` (1 `db.select`) wrapped in `try/catch` → per-merchant
  last-known-good, else catalog-row-with-null-pct bootstrap. `max-age=60`.
- **Verdict: never-500 holds.**

**`top-cashback-merchants.ts` (`publicTopCashbackMerchantsHandler`)**

- `limit` parsing: `Number.parseInt` + `Number.isNaN` guard + `Math.min/max`
  clamp — never throws, never produces a 400 (silently clamps instead, see
  PUB-10).
- `compute(limit)` wrapped in `try/catch` → per-limit last-known-good, else
  empty list. `max-age=60`.
- **Verdict: never-500 holds.**

**Defense-in-depth backstop:** `apps/backend/src/app.ts:189` (`app.onError`)
catches anything that slips past a handler's own guards and converts it to a
`500 INTERNAL_ERROR` + Sentry capture — confirms the contract above is the
_only_ thing standing between a public crawler and a literal 500 on this
surface, since the global handler would otherwise break ADR 020. No handler
in scope currently relies on it.

## Findings

### PUB-01 [P2 · LIVE] CF-29 TTL cache is per-process — N Fly machines multiply the cold-window DB load by N

- File: `apps/backend/src/public/cashback-stats.ts:65` (`let cache: ... = null`)
- Description: The new `cache` variable is module-level, in-process state.
  Fly (`apps/backend/fly.toml`) runs `min_machines_running = 1` but
  `auto_start_machines = true` with a 250-req hard concurrency limit per
  machine — i.e. the fleet scales to N machines under real load, and a
  rolling deploy briefly runs old + new machines side by side. Each machine
  independently starts with `cache = null` and independently pays the
  3-query `computeStats()` cost on its first hit, then independently re-pays
  it every `COMPUTE_TTL_MS` (5 min) thereafter, on its own clock (machines
  don't expire in lockstep — TTL windows desync across the fleet over time).
- Impact: the code comment ("every other request inside the window serves the
  memoised snapshot without touching the DB… a crawler storm inside the TTL
  window costs zero queries") is true _per machine_, not fleet-wide. Right
  after a deploy (every machine cold) or under a traffic spike that
  auto-starts new machines, DB load from this endpoint is `O(N_machines)`,
  not `O(1)`, exactly the failure mode flagged in checklist Part 6 §33. At
  current `min_machines_running=1` baseline this is dormant; it activates the
  moment the fleet scales past 1, which is precisely the situation a TTL
  cache exists to protect against.
- Evidence: `fly.toml:60-67` (`auto_start_machines`, `concurrency.hard_limit
= 250`); `cashback-stats.ts:58-65` doc comment claims process-level
  guarantee without flagging the multi-machine caveat.
- Minimal fix: document the per-machine caveat in the code comment so a
  future reader doesn't assume a fleet-wide guarantee; optionally lower
  `COMPUTE_TTL_MS` is _not_ the fix (it doesn't change the N-multiplier).
- Better fix: move the snapshot to a shared store (Redis/Postgres
  `unlogged` table/Fly's regional KV) keyed by a single TTL row, or — cheaper
  — accept the per-machine cost but make it negligible by keeping the
  underlying query cost low (already done via migration 0036's indexes), so
  N× a cheap query is still cheap. Given `min_machines_running=1` today and
  the query is now index-covered, a shared cache is over-engineering for
  current scale; the right minimal-but-correct move is the comment fix plus
  a monitoring note (alert if `computeStats()` call rate exceeds N_machines ×
  1/5min by a wide margin, which would indicate the memo isn't holding).

### PUB-02 [P2 · LIVE] CF-29 cache-fill has no single-flight de-dup — concurrent requests during a cold/expired window stampede the DB

- File: `apps/backend/src/public/cashback-stats.ts:144-178`
  (`publicCashbackStatsHandler`)
- Description: When `cache` is `null` or stale, every concurrent request that
  reaches the handler in that window independently calls `computeStats()` —
  there is no in-flight promise that later arrivals can await instead. Node's
  single-threaded event loop means many requests can interleave between the
  `if (cache !== null && fresh)` check and the `cache = {...}` write (each
  `await db.execute(...)` inside `Promise.all` yields the event loop), so a
  burst of M concurrent requests during a cache-miss window fires up to
  `3 × M` DB queries instead of 3.
- Impact: undermines the exact guarantee the comment claims ("a crawler burst
  inside the TTL window costs zero queries regardless of how many requests
  slip past the CDN edge") — that guarantee only holds once the cache is
  warm; it does not hold _during_ the fill. This is the highest-risk moment
  (right after a deploy / right after the 5-min TTL lapses under sustained
  traffic), which is exactly when a thundering herd is most likely and least
  affordable.
- Evidence: no mutex/in-flight-promise variable exists in the file; compare
  `merchants/sync.ts:76,89-91` (`isMerchantRefreshing` + `RefreshOutcome`)
  which is the established single-flight/coalescing pattern already used
  elsewhere in this codebase for an analogous "many concurrent triggers,
  one underlying refresh" problem.
- Minimal fix: add a module-level `let inFlight: Promise<PublicCashbackStats>
| null = null;` — when a recompute is needed, set `inFlight =
computeStats().finally(() => { inFlight = null; })` once, and have all
  concurrent callers `await` the same promise instead of calling
  `computeStats()` themselves.
- Better fix: same as above, generalized into a small reusable
  `memoizeWithTtl(fn, ttlMs)` helper so the next public-stats endpoint that
  needs this (see PUB-09) gets it for free instead of re-deriving the pattern.

### PUB-03 [P2 · LIVE] `PublicCashbackPreview.merchantId` is documented as the CTX merchant id but actually contains the slug

- File: `apps/backend/src/public/cashback-preview.ts:200-207`;
  `packages/shared/src/public-cashback-preview.ts:27-28`
- Description: The handler returns `merchantId: resolved.slug` (line 201,
  also the soft-empty fallback at line 187), but the shared type's own JSDoc
  says `/** CTX merchant id (catalog-anchored stable identifier). */` and the
  file header's example (`merchantId: "amazon-us"`) reads as an id. Sibling
  types in the same vertical (`PublicMerchantDetail`, `TopCashbackMerchant`)
  deliberately expose **both** `id` and `slug` as distinct fields — this
  endpoint is the only one in the public-merchant family that collapses them
  into one misleadingly-named field.
- Impact: a consumer (current or future) that takes this response's
  `merchantId` at face value and feeds it into an id-keyed lookup (e.g.
  `POST /api/orders/loop`, which resolves strictly via `merchantsById` with
  **no** slug fallback — confirmed in `orders/loop-handler.ts`) gets a wrong
  result (404/`VALIDATION_ERROR`) in every case where the slug differs from
  the id, which is most merchants. No live code path does this chaining
  today (verified: the web purchase flow always resolves `merchant.id`
  independently from the route loader's catalog lookup, never from a
  cashback-preview response), so this is a contract-correctness bug, not a
  live incident — but it is exactly the kind of "looks right, silently
  wrong" trap a future integration (marketing partner, internal refactor)
  would fall into without warning, since both the response and the type
  pass typecheck cleanly.
- Evidence: `cashback-preview.ts:201` `merchantId: resolved.slug,`;
  `loop-handler.ts` resolves `merchantsById.get(parsed.data.merchantId)`
  only (no `?? merchantsBySlug.get(...)` fallback, unlike
  `cashback-preview.ts`'s own `resolveMerchant()`).
- Minimal fix: fix the JSDoc on `PublicCashbackPreview.merchantId` to
  accurately say "country-aware marketing slug, not the CTX catalog id" and
  update the file-header example/description in `cashback-preview.ts` to
  match.
- Better fix: align the shape with `PublicMerchantDetail`/
  `TopCashbackMerchant` — add `slug` as its own field and populate
  `merchantId` with `resolved.id` (the real id), which is also what the
  field name promises. This is a response-shape change behind a stable,
  unauthenticated, ADR-019-governed type, so it needs the standard shared-type
  - OpenAPI + web-consumer update in lockstep, but is low-risk since nothing
    currently parses the old (wrong) semantics.

### PUB-04 [P2 · LIVE] `GET /api/public/geo` has zero test coverage — the only handler in the vertical without one

- File: `apps/backend/src/public/geo.ts` (no
  `apps/backend/src/public/__tests__/geo.test.ts` exists)
- Description: Every sibling handler (`cashback-preview`, `cashback-stats`,
  `flywheel-stats`, `loop-assets`, `merchant`, `top-cashback-merchants`) has a
  dedicated test file covering the happy path, the never-500 fallback, and
  edge cases. `geo.ts` has none — the lazy-open memoization, the
  `MAXMIND_GEOLITE2_PATH`-absent fallback, the `reader.get()`-throws fallback,
  the no-PII guarantee ("IP never echoed/logged"), and the
  `regionForCountry` mapping are all unverified by CI.
- Impact: this endpoint is the live engine behind `home-geo-redirect.tsx`,
  one of only two documented exceptions to the "web is a pure API client"
  rule (AGENTS.md rule 1) and the mechanism ADR 034 relies on to "kill the US
  flash" for every non-US visitor hitting `/`. A regression here (e.g. a
  refactor that breaks the null-DB fallback, or a `clientIpFor` change that
  breaks IP resolution under `TRUST_PROXY`) would silently misroute every
  visitor's first-touch country guess with no test catching it before prod.
- Evidence: `find apps/backend/src/public/__tests__` lists 6 files, not 7;
  the prior 2026-06-15 audit (`docs/audit-2026-06-15-cold/raw/v-catalog.md`,
  finding C-07) flagged the identical gap as P3 and it is still
  unremediated 22 commits later — two independent cold passes now agree this
  file alone lacks coverage. I rate it P2 (one notch above the prior pass)
  given its role in the SSR critical-path exception.
- Minimal fix: add `geo.test.ts` covering: DB-absent fallback (`{countryCode:
'', region: 'US'}`), `open()`-rejects fallback, `reader.get()`-throws
  fallback, happy-path country→region mapping, and a check that no IP
  appears in any header/body of the response.
- Better fix: same, plus a regression test asserting `clientIpFor`'s
  `TRUST_PROXY` branch is exercised end-to-end through this handler (today
  only `middleware/__tests__/trust-proxy.test.ts` covers `clientIpFor`
  directly, not through a real consumer).

### PUB-05 [P2 · LIVE] GeoLite2 open/lookup failures are completely silent — no log line anywhere

- File: `apps/backend/src/public/geo.ts:15-23,39-47`
- Description: `geoReader()` swallows `open()` rejection via
  `.catch(() => null)` with no logging; the handler's own `catch { countryCode
= ''; }` around `reader.get(...)` likewise logs nothing. `geo.ts` doesn't
  even import `logger`. There is also no boot-time check anywhere
  (`index.ts`, `runtime-health.ts`) that validates `MAXMIND_GEOLITE2_PATH`
  points at a working `.mmdb`, and no metric/health-check ties the reader's
  load state to anything observable.
- Impact: a misconfigured path, a corrupted/stale `.mmdb` (the docs index
  itself lists "GeoLite2 mmdb refresh cadence/staleness" as an open
  orphaned-work item), wrong file permissions, or a `maxmind` library
  upgrade that changes its error shape would silently degrade **every**
  visitor's `/` redirect to the US default forever, with zero signal in
  logs, Sentry, Discord, or `/health` — directly violating checklist Part 1
  §6 ("No alert gaps / silent failures"). This is a real product/SEO
  regression vector (wrong-country redirects fleet-wide) that nothing would
  catch except a human noticing analytics drift.
- Evidence: `grep -n "MAXMIND\|geoReader\|GeoLite" apps/backend/src/index.ts
apps/backend/src/runtime-health.ts` → no hits.
- Minimal fix: log a `warn` (once, not per-request, to avoid log spam) when
  `open()` rejects, and a `debug`/`warn` on `reader.get()` throwing.
- Better fix: surface GeoLite2 reader status on `/health` (or a dedicated
  metric) so it's visible in the same place other worker/store staleness is
  already surfaced (per AGENTS.md "Metrics / health endpoints; worker
  liveness + staleness"), and add a boot-time log line stating whether geo
  lookup is enabled/disabled, so a misconfigured prod deploy is visible on
  day one instead of discovered via silent redirect drift.

### PUB-06 [P3 · LIVE] `merchant.ts` 400/404 paths don't set Cache-Control, unlike the A4-094 precedent in `cashback-preview.ts`

- File: `apps/backend/src/public/merchant.ts:99-110`
- Description: `cashback-preview.ts` explicitly hardens every validation/404
  branch with a short public `Cache-Control` (documented as the A4-094 fix:
  "even validation-failure 4xx envelopes carry a short public Cache-Control
  header… so a CDN keyed on URL alone" behaves predictably). `merchant.ts`'s
  `idParam` missing/malformed (400) and unknown-merchant (404) branches set
  no header at all — same class of problem A4-094 was written to close,
  left unaddressed in the sibling handler.
- Impact: low — worst case is CDN-default behavior (typically "don't cache")
  for a 400/404 on this route, which is the safe direction, not a security
  issue. But it's an inconsistency in a hardening pattern this codebase
  explicitly invested in once already.
- Evidence: `merchant.test.ts` exercises the 400/404 paths (lines 89-102) but
  never asserts on `cache-control`, confirming the gap isn't accidentally
  covered.
- Minimal fix: add the same `c.header('cache-control', 'public,
max-age=60')` (or factor `cashback-preview.ts`'s `setShortPublicCache`
  helper into a tiny shared util) on `merchant.ts`'s 400/404 returns.
- Better fix: extract a one-line `setShortPublicCache(c)` helper shared by
  every public handler with an early-validation exit, so the next new public
  endpoint gets this for free instead of needing its own A4-094 rediscovery.

### PUB-07 [P3 · LIVE] `MERCHANT_ID_RE` / `MERCHANT_ID_MAX` duplicated verbatim across two files

- File: `apps/backend/src/public/cashback-preview.ts:47-48`;
  `apps/backend/src/public/merchant.ts:41-42`
- Description: Both files independently declare `const MERCHANT_ID_RE =
/^[A-Za-z0-9._-]+$/;` and `const MERCHANT_ID_MAX = 128;`. Identical today,
  but nothing enforces they stay identical — a future tightening in one file
  (e.g. a CTX id-format change) is easy to apply to only one copy.
- Impact: low, pure maintainability/DRY (checklist §14).
- Evidence: byte-identical declarations in both files.
- Minimal fix: none required if accepted as intentional file-local
  isolation.
- Better fix: hoist both constants into a small shared module (e.g.
  `public/merchant-id.ts`) imported by both, or into `@loop/shared` if a
  third consumer (e.g. a future admin-facing merchant-id validator) ever
  needs the same charset/length rule.

### PUB-08 [P3 · LIVE] `Cache-Control` header casing inconsistent across the vertical

- File: `cashback-preview.ts`, `cashback-stats.ts`, `merchant.ts`,
  `top-cashback-merchants.ts` use lowercase `'cache-control'`;
  `flywheel-stats.ts`, `geo.ts`, `loop-assets.ts` use `'Cache-Control'`.
- Description: HTTP header names are case-insensitive so this has no runtime
  effect, but it's an unforced inconsistency within one cohesive vertical
  that was clearly built as a single discipline (every file's doc comment
  cites the same ADR 020 convention).
- Impact: none functionally; pure consistency nit.
- Minimal fix: pick one casing (lowercase matches Hono's own internal
  convention) and apply it everywhere in `public/`.
- Better fix: same.

### PUB-09 [P3 · LIVE] CF-29's TTL-memoization pattern wasn't extended to `flywheel-stats.ts`, which runs a similarly-shaped full aggregate every request

- File: `apps/backend/src/public/flywheel-stats.ts:76-89`
- Description: `flywheel-stats.ts` queries `orders` with `state='fulfilled'
AND fulfilled_at >= <30d window>` on **every single request**, with no
  process-level memo — only the existing last-known-good-on-error pattern,
  not a TTL cache. The query is currently well-served by the pre-existing
  partial index `orders_fulfilled_at WHERE state='fulfilled'` (confirmed in
  `db/schema.ts:604-606`), so the per-request cost is low today, but it's the
  same crawler-storm risk shape PERF-001/CF-29 was written to close for
  `cashback-stats.ts`, just left unaddressed here.
- Impact: low today given the index coverage; would compound if the `orders`
  table grows enough that even an index range-scan becomes non-trivial, or
  if traffic to this specific marketing endpoint spikes independently of
  `cashback-stats`.
- Evidence: no `cache`/`computedAt`/`COMPUTE_TTL_MS` machinery in
  `flywheel-stats.ts`, contrast with `cashback-stats.ts:51-65`.
- Minimal fix: none required immediately — flag for the next perf pass.
- Better fix: factor PUB-02's recommended `memoizeWithTtl(fn, ttlMs)` helper
  and apply it uniformly to every public aggregate handler
  (`cashback-stats`, `flywheel-stats`, and arguably `top-cashback-merchants`)
  rather than re-deriving the pattern per-file as traffic grows.

### PUB-10 [P3 · LIVE] OpenAPI `limit` schema for top-cashback-merchants declares strict bounds; runtime silently clamps instead of rejecting

- File: `apps/backend/src/openapi/public.ts:206-210` vs
  `apps/backend/src/public/top-cashback-merchants.ts:90-95`
- Description: The registered Zod schema is `z.coerce.number().int().min(1)
.max(50).optional()`, which (if used for codegen-driven request validation
  by a consumer, or by anyone reading the JSON Schema literally) implies
  `limit=0` or `limit=51` are rejected. The actual handler never rejects —
  it clamps (`Math.min(Math.max(parsed, 1), 50)`), confirmed by
  `top-cashback-merchants.test.ts`'s "clamps ?limit" test. The prose
  `description` on the same registration _does_ correctly say "clamped
  1..50", so a careful reader isn't misled, but the machine-readable schema
  contradicts the human-readable prose on the same path object.
- Impact: low — affects only OpenAPI-driven codegen/contract-test tooling,
  not runtime behavior (this registry isn't wired to actual request
  validation; routes/public.ts mounts the handler directly with no
  zod-openapi binding).
- Evidence: schema vs. handler vs. test as cited.
- Minimal fix: none required — purely descriptive drift, not enforced
  anywhere.
- Better fix: drop `.min(1).max(50)` from the registered schema (just
  `z.coerce.number().int().optional()`) so the JSON Schema doesn't imply a
  rejection contract the server doesn't honor, and let the prose carry the
  clamping behavior as it already does.

### PUB-11 [P3 · LIVE] `GeoResponse.region` is documented "vestigial" but still a first-class response field; its only web-side consumer export is dead code

- File: `packages/shared/src/regions.ts:1-8,119-125`;
  `apps/web/app/services/geo.ts:9-11`
- Description: `regions.ts`'s own header comment says the region selector
  is "retired" and `GeoResponse.region` is kept only "for backward
  compatibility" (superseded by ADR 034's per-country model). The backend
  still computes and returns it on every `/api/public/geo` call, and the
  OpenAPI spec (`openapi/public.ts:166-178`) documents it as a normal field
  with no "deprecated" annotation. Separately, `apps/web/app/services/geo.ts`
  exports `fetchGeo()` wrapping this endpoint — `grep` across `apps/web/app`
  finds zero importers of `fetchGeo`; the one live consumer
  (`home-geo-redirect.tsx`) calls `fetch()` directly (correctly, per the
  documented SSR-loader exception) and only reads `.countryCode`, never
  `.region`.
- Impact: none functionally — pure completeness-sweep / doc-accuracy item
  (checklist Part 5 "orphaned files/exports", "documented-but-unimplemented
  reversed: implemented-but-undocumented-as-dead").
- Evidence: as cited; also flagged independently in the 2026-06-15 audit
  (`docs/audit-2026-06-15-cold/raw/v-shared.md:96`: "When `regions.ts` is
  finally deleted, ensure `GeoResponse`… moves… first") — still unaddressed.
- Minimal fix: mark `region` `@deprecated` in the shared type + OpenAPI
  `.openapi({ deprecated: true })`, and delete the unused `fetchGeo()`
  export (or its whole file) from `apps/web/app/services/geo.ts`.
- Better fix: same, plus a tracked follow-up to actually drop `region` from
  the wire shape once confirmed zero consumers remain (it's unauthenticated
  and CDN-cached, so removal is a safe additive-then-subtractive rollout,
  not a breaking change for any known client).

### PUB-12 [P3 · LIVE] `amountMinor` query param has no length cap before `BigInt()` parse

- File: `apps/backend/src/public/cashback-preview.ts:134-156`
- Description: `amountRaw` (the raw `?amountMinor=` query string) is
  regex-validated as digits-only and then range-checked against
  `AMOUNT_MINOR_MAX` (10,000,000 → 8 digits) **after** `BigInt(amountRaw)`
  has already parsed it. There's no explicit length cap before the `BigInt()`
  call. `BigInt()` parsing of very long decimal strings is known to be
  super-linear in some V8 versions; an attacker-supplied multi-KB digit
  string (bounded only by the server's HTTP request-line/header size limit,
  not by anything in this handler) does unnecessary parse work before being
  rejected by the range check.
- Impact: low in practice — legitimate values need at most 8 digits, and
  Node's default header/request-line size ceiling already bounds the
  practical string length to a few KB, keeping any quadratic blowup small.
  Still, the file already declares an explicit `AMOUNT_MINOR_MAX` intent; a
  cheap pre-check is free defense-in-depth and removes the dependency on an
  unstated, framework-level ceiling.
- Evidence: `cashback-preview.ts:142-159` — regex test, then `BigInt()`,
  then range check, no length gate in between.
- Minimal fix: add `if (amountRaw.length > 8) { /* reject */ }` (8 = digit
  count of `AMOUNT_MINOR_MAX`) before the `BigInt()` call, or fold it into
  the existing `/^\d+$/` regex as `/^\d{1,8}$/`.
- Better fix: same; also consider applying the same digit-length pattern to
  any other public/admin endpoint that parses a caller-supplied numeric
  string into `BigInt` before range-checking it (cross-cutting sweep, not
  scoped to this file alone).

### PUB-13 [P3 · LIVE] `cashbackPctToBps` re-implements money-shaped percentage math via float instead of reusing the exact bigint-string parser

- File: `apps/backend/src/public/cashback-preview.ts:96-100`; compare
  `apps/backend/src/orders/cashback-split.ts:71-86` (`applyPct`)
- Description: The authoritative order-insert path parses `numeric(5,2)`
  pct strings exactly via bigint string-splitting (`applyPct`); the preview
  endpoint instead does `Math.round(Number(pct) * 100)` — a second,
  independent, float-based implementation of the same "percentage string to
  bps" conversion the project otherwise treats as money-grade logic (ADR-019
  DRY convention, checklist §25 "no duplicate money math").
- Impact: I verified this is **not currently a practical correctness bug**:
  for any value in the actual domain (a `numeric(5,2)` column, 0–100
  inclusive, i.e. at most 4 significant decimal digits), IEEE-754 double
  multiplication error at this magnitude is on the order of `1e-13`, many
  orders of magnitude below the `0.5` needed to flip `Math.round`'s output
  across an integer boundary — so `cashbackPctToBps` returns the exact
  correct bps for every value the DB can actually hold today. The risk is
  architectural/future-proofing: it's a second money-math implementation
  that could silently diverge if the column's precision/scale ever changes,
  and it fails the project's own "single source of truth for money math"
  convention.
- Evidence: `cashback-preview.ts:97-99` (`Number(pct)`, `Math.round`) vs.
  `cashback-split.ts:71-86` (exact bigint string split, no float anywhere).
  Independently flagged in the 2026-06-15 audit
  (`docs/audit-2026-06-15-cold/raw/v-catalog.md`, finding C-04) as P2; I
  rate it P3 after working through the actual float-error bound above, which
  shows the practical risk is categorically smaller than that pass implied.
- Minimal fix: none required for correctness today.
- Better fix: extract `applyPct`'s exact bigint-string-splitting logic (or
  `cashbackPctToBps`'s float one, whichever is kept) into one shared
  `pctStringToBps` / `applyPctExact` helper imported by both
  `cashback-split.ts` and `cashback-preview.ts`, closing the DRY gap
  regardless of which implementation wins.

## Delta re-verification

**CF-29 (cashback-stats TTL cache + indexes) — verdict: substantially closed
for the single-instance threat model it targeted; two residual multi-machine
gaps remain (PUB-01, PUB-02).**

The prior pass's PERF-001 finding
(`docs/audit-2026-06-15-cold/raw/x-perf.md:11-21`) identified three concrete
problems in `cashback-stats.ts`: (1) no compute-level cache — `lastKnownGood`
was error-fallback-only, so a real DB recompute fired on every cache-miss
including CDN-edge-region misses; (2) no supporting index on
`credit_transactions(type)`, forcing a full-table scan for the cashback
roll-up; (3) the three aggregate queries were awaited sequentially instead of
concurrently.

Verified against the current code:

- **(1) closed** — `COMPUTE_TTL_MS = 5 * 60 * 1000` + the `cache` variable
  now genuinely memoizes `computeStats()` output for 5 minutes,
  independent of the error-fallback role it also plays. Confirmed via the
  dedicated test `'CF-29/PERF-001: serves the TTL memo without re-querying
the DB inside the window'` in `cashback-stats.test.ts:159-176`, which
  asserts `state.calls.length` doesn't grow on a second request inside the
  TTL window — this test passes against the current implementation.
- **(2) closed** — migration `0036_perf_admin_and_stats_indexes.sql` adds
  `credit_transactions_type_created (type, created_at)`, explicitly called
  out in its own comment as "doubles as the supporting index for PERF-001's
  public cashback-stats roll-up." Verified the index exists in both the
  migration SQL and the matching `db/schema.ts` declaration (migration↔schema
  parity). The `orders WHERE state='fulfilled'` count was already covered by
  the pre-existing partial index `orders_fulfilled_at`, unaffected by this
  PR.
- **(3) closed** — `computeStats()` now wraps all three `db.execute` calls in
  a single `Promise.all([...])` (`cashback-stats.ts:98-117`), down from
  sequential awaits.

**What CF-29 did _not_ close**, because PERF-001 was framed and fixed from a
single-process perspective: the in-process `cache` variable is invisible
across Fly machines. PUB-01 (N-machine cold-window multiplication) and PUB-02
(missing single-flight de-dup during a cache-fill race) are both new gaps
introduced — or rather, left latent — by this exact fix, not regressions of
the original PERF-001 behavior (which was strictly worse: every machine hit
the DB on _every_ request, not just during cold windows). Net assessment:
CF-29 is a real, substantial improvement and closes its stated scope
correctly; it is not yet "closed" in the stronger sense the audit brief asked
me to check (cross-machine correctness under Part 6 §33), and the code
comments slightly overstate the guarantee by not flagging the per-machine
caveat.

No never-500 or no-PII regression found in the CF-29 diff — the fallback
ladder (TTL-memo → fresh compute → last-known-good → zeroed bootstrap) is
strictly more robust than the pre-CF-29 version, and no PII was introduced
into the cached/returned shape.

## Coverage confirmation

Backend handlers (required scope, read in full):

- `apps/backend/src/public/cashback-preview.ts`
- `apps/backend/src/public/cashback-stats.ts`
- `apps/backend/src/public/flywheel-stats.ts`
- `apps/backend/src/public/geo.ts`
- `apps/backend/src/public/loop-assets.ts`
- `apps/backend/src/public/merchant.ts`
- `apps/backend/src/public/top-cashback-merchants.ts`
- `apps/backend/src/routes/public.ts`
- `apps/backend/src/openapi/public.ts`
- `apps/backend/src/openapi/public-merchants.ts`

Tests (read in full):

- `apps/backend/src/public/__tests__/cashback-preview.test.ts`
- `apps/backend/src/public/__tests__/cashback-stats.test.ts`
- `apps/backend/src/public/__tests__/flywheel-stats.test.ts`
- `apps/backend/src/public/__tests__/loop-assets.test.ts`
- `apps/backend/src/public/__tests__/merchant.test.ts`
- `apps/backend/src/public/__tests__/top-cashback-merchants.test.ts`
- (confirmed absent: `geo.test.ts` — PUB-04)

Cross-referenced for verification (not primary scope, read in full or in
targeted part):

- `packages/shared/src/public-merchant.ts`
- `packages/shared/src/public-cashback-preview.ts`
- `packages/shared/src/public-cashback-stats.ts`
- `packages/shared/src/public-top-cashback-merchants.ts`
- `packages/shared/src/public-loop-assets.ts`
- `packages/shared/src/public-flywheel-stats.ts`
- `packages/shared/src/regions.ts`
- `apps/backend/src/middleware/rate-limit.ts` (per-machine state confirmation
  for `clientIpFor`/`rateLimit`, and the `RATE_LIMIT_MAP_MAX` eviction
  pattern — consistent with PUB-01's distributed-state concern but not a new
  finding since it's already a known/documented limitation, A4-001)
- `apps/backend/src/merchants/sync.ts` (`getMerchants()` never-throw proof;
  `isMerchantRefreshing` single-flight precedent cited in PUB-02)
- `apps/backend/src/credits/payout-asset.ts` (`configuredLoopPayableAssets`
  purity proof for `loop-assets.ts`)
- `apps/backend/src/db/schema.ts` (orders + merchant_cashback_configs index
  inventory, migration-parity cross-check)
- `apps/backend/src/db/migrations/0036_perf_admin_and_stats_indexes.sql`
  (CF-29 index-add verification)
- `apps/backend/src/orders/cashback-split.ts` (`applyPct` exact-parse
  comparison for PUB-13)
- `apps/backend/src/orders/loop-handler.ts` (merchantId resolution — via
  sub-agent — for PUB-03's blast-radius assessment)
- `apps/backend/fly.toml` (`min_machines_running` / `auto_start_machines` /
  concurrency limits for PUB-01)
- `apps/backend/src/app.ts` (`app.onError` global backstop)
- `apps/web/app/routes/home-geo-redirect.tsx`, `apps/web/app/services/geo.ts`
  (geo.ts's only live consumer + the dead `fetchGeo()` export for PUB-11)

Cross-checked against (after forming independent judgment, per audit
protocol): `docs/audit-2026-06-15-cold/raw/v-catalog.md` (prior pass's V6+V7
combined coverage), `x-perf.md` (PERF-001, the finding CF-29 fixes),
`x-privacy.md`, `x-infra.md`, `x-docs.md`, `x-adr.md`, `v-shared.md` — used
only to corroborate/calibrate severity on findings already reached
independently (PUB-03 ≈ prior C-02, PUB-04 ≈ prior C-07, PUB-13 ≈ prior C-04
recalibrated to P3 with float-error-bound reasoning shown), not copied
forward as new claims.
