# Cold Audit 2026-06-15 — Performance Sweep (checklist §13)

Branch: `fix/stranded-order-hardening`. Scope: DB query/index hygiene, backend hot
paths (clustering, catalog, rate-limit, workers), web bundle/query/LCP, memory/leaks,
worker tick cost. Where a live measurement wasn't possible the reasoning is from code +
schema with the assumption noted.

---

## Findings

### P1 — Public stats endpoints run unwindowed full-table aggregates with no compute cache and no supporting index

- **id:** PERF-001
- **severity:** P1
- **vertical:** V7 (public API) / V13 (DB)
- **file:** `apps/backend/src/public/cashback-stats.ts:65-100`
- **description:** `computeStats()` runs three aggregates per invocation: `COUNT(DISTINCT user_id) … WHERE type='cashback'`, `COUNT(*) … WHERE state='fulfilled'`, and `SUM(amount_minor) GROUP BY currency WHERE type='cashback'` — all over the **entire** `credit_transactions` / `orders` tables with **no time-window bound**. `credit_transactions` has no index on `type` alone (only `(user_id, created_at)` and `(reference_type, reference_id)`); the `orders` count can index-scan the `orders_fulfilled_at` partial but still touches every fulfilled order ever. `lastKnownGood` is only an error-path fallback — it is NOT a TTL compute cache, so a real recompute fires on every cache-miss (and once per CDN edge region) despite the 5-min HTTP `Cache-Control`.
- **impact:** Cost grows linearly with the ledger forever. On a public, crawler-reachable surface (this feeds the landing page) a thundering-herd of edge misses can pin 3 sequential full scans of the largest two tables. The endpoint is documented never-500 but not never-slow.
- **evidence:** three `db.execute(sql\`…\`)`blocks at lines 67-95, no`created_at`/`fulfilled_at`lower bound on the first two; awaited sequentially.`flywheel-stats.ts:77-89`is the correct counter-example — it windows to`WINDOW_DAYS`.
- **fix:** add a process-level TTL memo around `computeStats()` (e.g. recompute at most once/5min, serve the memo otherwise — `lastKnownGood` already exists, just gate it on age); add an index on `credit_transactions(type)` or `(type, currency, amount_minor)` for an index-only roll-up; run the three queries with `Promise.all`. Long-term, back the all-time totals with a periodically-refreshed rollup row.
- **ref:** ADR 020 (never-500), checklist §13 (full-table scans, caching).

### P1 — Cluster handler re-filters the full ~116k-location array on every request (no spatial index)

- **id:** PERF-002
- **severity:** P1
- **vertical:** V6 (clustering)
- **file:** `apps/backend/src/clustering/handler.ts:73-86`, `apps/backend/src/clustering/algorithm.ts:53-104`
- **description:** Each `GET /api/clusters` does `locations.filter(...)` — a linear O(N) scan over the whole in-memory location array (the store comment caps pagination at 500k records; the live catalog is in the ~100k range) — then a second O(N) grid-bucketing pass in `clusterLocations`. There is no spatial index (grid/quadtree/R-tree); every request at every zoom walks all points even when the viewport covers a tiny bbox.
- **impact:** At 60 req/min/IP budget and N≈116k, that is ~2 full array scans × request. A map being panned by many concurrent users multiplies the per-request cost; the work is on the request thread (no worker offload). Each scan also allocates a new `filtered` array + a `Map<string, Location[]>`, so GC pressure scales with traffic. Acceptable at launch volume; a cliff as either N or concurrency grows.
- **evidence:** `handler.ts:76` `locations.filter(...)`; `algorithm.ts:90-104` builds `cells` Map by iterating all `locations` each call; no persisted bucket index in `data-store.ts`.
- **fix:** build a coarse grid index once per location-refresh (24h cadence) keyed by integer lat/lng cell, then the per-request path only scans cells overlapping the expanded bbox. Alternatively memoize results per (rounded-bbox, zoom) for the 60s cache window. The 60s `Cache-Control` helps CDN but not same-bbox-different-client compute.
- **ref:** checklist §13 (algorithmic complexity, clustering at zoom).

### P1 — Full merchant catalog prefetched + focus-refetched on every web route

- **id:** PERF-003
- **severity:** P1
- **vertical:** V9 (web client)
- **file:** `apps/web/app/root.tsx:165-178`; `apps/web/app/hooks/use-merchants.ts:38,71`
- **description:** `queryClient.prefetchQuery(['merchants-all'])` runs at root-module evaluation for **all** routes (settings, admin, orders, auth — not just home/map/search). The query (`useAllMerchants`) additionally sets `refetchOnWindowFocus: true` + `refetchOnReconnect: true`, so the full ~1,134-record catalog payload re-downloads on every tab focus once the 5-min `staleTime` lapses. Backend serves the whole cached array (`merchants/handler.ts:91-95`).
- **impact:** Multi-hundred-KB JSON fetched on first load of any route and re-fetched on every focus, including routes that never render the catalog. Wasted bandwidth + main-thread JSON parse on mobile/native webview.
- **evidence:** root.tsx prefetch is unconditional at module scope; `use-merchants.ts:38,71` focus/reconnect flags; localStorage cache (`loop_merchants_all_v1`) already covers cold-start render so the eager network prefetch is redundant on non-catalog routes.
- **fix:** move the prefetch into the routes that consume it (home/map/search/navbar); set `refetchOnWindowFocus: false` for the catalog query (catalog churns slowly, staleTime + localStorage cover freshness).
- **ref:** checklist §13 (over-fetching, payload sizes); web-agent corroborated.

### P1 — Sentry SDK (~540 KB) statically imported into root, loads on every page

- **id:** PERF-004
- **severity:** P1
- **vertical:** V9 (web client) / bundle budget
- **file:** `apps/web/app/root.tsx:12,44-75`
- **description:** `@sentry/react` is statically imported in `root.tsx` and pulled into the always-loaded root chunk (`esm` chunk ≈ 540 KB — the single largest). `Sentry.init` is runtime-guarded on `VITE_SENTRY_DSN`, but the module bytes ship regardless. The browser-tracing integration with CLS/LCP/LongAnimationFrame spans is the heavy part.
- **impact:** ~540 KB JS downloaded/parsed on first load for every visitor (including DSN-unset deploys). Dominates the SSR bundle budget; the budget gate (`MAX_SSR_KB=3300`) was reset to "current + headroom" so it only catches new regressions, not this bloat.
- **evidence:** static `import * as Sentry` at root.tsx:12; build output `esm` chunk 540 KB; `scripts/check-bundle-budget.sh:31-53` documents the budget reset.
- **fix:** lazy `import('@sentry/react')` only when `VITE_SENTRY_DSN` is set; wrap `ErrorBoundary`/QueryCache `onError` in a small async shim. Frees ~540 KB and lets `MAX_SSR_KB` ratchet down.
- **ref:** checklist §13 (bundle budget, code-split).

### P1 — Hot admin time-series / treasury endpoints do full-table or non-sargable scans (missing `created_at` indexes)

- **id:** PERF-005
- **severity:** P1
- **vertical:** V8 (admin) / V13 (DB)
- **file:** `apps/backend/src/admin/orders-activity.ts:53-73`; `apps/backend/src/admin/treasury.ts:62-69`; `apps/backend/src/admin/cashback-realization.ts:66-94`; the daily-series cluster: `cashback-activity.ts:80-99`, `cashback-activity-csv.ts:72-92`, `cashback-realization-daily.ts:80-107`, `cashback-realization-daily-csv.ts:77-105`, `treasury-credit-flow.ts:107-133`, `treasury-credit-flow-csv.ts:91-137`
- **description:** Two compounding problems: (a) **no plain btree index on `orders.created_at` or `credit_transactions.created_at`** (only composite `(user_id, created_at)` whose leading column doesn't help an unfiltered range); (b) the daily-series joins use `created_at::date = days.d` / `DATE_TRUNC('day', created_at)`, which is **non-sargable** — a range index couldn't be used even if it existed. `orders-activity` (default dashboard sparkline) joins the _entire_ orders table with no `created_at` lower bound. `treasury.ts:62` and `cashback-realization.ts:66` aggregate the _entire_ `credit_transactions` ledger with no window at all.
- **impact:** Each admin dashboard open / CSV pull triggers a sequential scan of the largest growing tables; cost grows forever. `orders-activity` and `treasury` are the two most-opened admin views.
- **evidence:** schema.ts has no `index(...).on(t.createdAt)` for orders or credit_transactions standalone; admin-agent enumerated each join. Counter-examples that ARE covered: `merchant-stats.ts`, `supplier-spend.ts`, `operator-latency.ts` use the `orders_fulfilled_at` / `orders_fulfilled_merchant_at` partials.
- **fix:** add `index('orders_created_at').on(t.createdAt)` and `index('credit_transactions_type_created').on(t.type, t.createdAt)`; rewrite the date-cast joins to half-open ranges (`ct.created_at >= d AND ct.created_at < d + interval '1 day'`); push the window into `orders-activity`'s join; back the all-time `treasury`/`cashback-realization` totals with a rollup or a covering index `INCLUDE (amount_minor)`.
- **ref:** checklist §9 (indexes for hot query), §13.

### P2 — Several admin filters/aggregates lack covering indexes (degrade with volume)

- **id:** PERF-006
- **severity:** P2
- **vertical:** V8 (admin) / V13 (DB)
- **file:** `apps/backend/src/admin/operator-stats.ts:80-84` & `operators-snapshot-csv.ts:124-174` (`ctx_operator_id IS NOT NULL AND created_at>=since` — `orders_ctx_operator` can't serve the range); `payouts-by-asset.ts:69-77` (`GROUP BY asset_code,state` over full `pending_payouts`, no `asset_code` index); `settlement-lag.ts:96-101` / `payouts-activity.ts:92-112` / `payouts-activity-csv.ts:71-92` (`state='confirmed' AND confirmed_at>=since`, no `confirmed_at` index); `users-recycling-activity.ts:87-102` & `-csv.ts:78-93` (`payment_method='loop_asset' AND created_at>=90d`, no index on either); `stuck-orders.ts:92-113` (`state IN ('paid','procuring')` — `paid` has no supporting partial); `user-by-email.ts:88` (`LOWER(email)=x` for ctx-backed users — only partial functional index `WHERE ctx_user_id IS NULL` exists); `users-list.ts:79-95` & `user-search.ts:98-109` (leading-wildcard `LOWER(email) LIKE '%q%'` — guaranteed seq scan + sort).
- **description:** Each filters/sorts on a column or expression no index covers. Bounded today (admin traffic is tiny, results capped) but each degrades as the relevant table grows.
- **impact:** Slow admin views / CSV exports at scale; the email-substring search is the worst (full `users` scan per keystroke-driven request).
- **fix:** `orders(ctx_operator_id, created_at)`; `pending_payouts(asset_code, state) INCLUDE (amount_stroops)`; partial `pending_payouts(confirmed_at) WHERE state='confirmed'`; partial `orders(created_at) WHERE payment_method='loop_asset'`; partial `orders(created_at) WHERE state IN ('paid','procuring')`; non-partial functional `users(LOWER(email))`; `pg_trgm` GIN on `LOWER(email)` if substring search becomes hot.
- **ref:** checklist §9, §13. Admin-agent enumerated.

### P2 — Drift watcher sums `user_credits` per-currency with no `currency` index, plus serial Horizon reads

- **id:** PERF-007
- **severity:** P2
- **vertical:** V3 (payments) / V13 (DB)
- **file:** `apps/backend/src/credits/liabilities.ts:18-26`; `apps/backend/src/payments/asset-drift-watcher.ts:167-251`
- **description:** `sumOutstandingLiability(currency)` does `SUM(balance_minor) WHERE currency=X`. `user_credits` PK is `(user_id, currency)` — leading column `user_id`, so a `WHERE currency=X` predicate **cannot** use the PK index → seq scan. Called once per LOOP asset (3) per drift tick (every 300s). Within `runAssetDriftTick` the per-asset loop awaits `getLoopAssetCirculation` → `getAssetBalance` → `sumOutstandingLiability` strictly **sequentially**, so each tick is ~6+ serial Horizon round-trips + 3 seq scans.
- **impact:** `user_credits` is small (bounded by users × ≤3 currencies) so the scan is cheap now; the serial Horizon path makes each tick latency ≈ sum of all round-trips, but at 300s cadence with `.unref()` this is acceptable. Flagged for the index gap and the serial pattern as volume/asset-count grows.
- **fix:** add `index('user_credits_currency').on(t.currency)` (or sum all currencies in one `GROUP BY currency` query per tick); parallelize the independent Horizon reads per asset with `Promise.all`.
- **ref:** checklist §13 (worker per-tick cost, Horizon efficiency), §9.

### P2 — Home directory renders ~982 merchant cards with no virtualization

- **id:** PERF-008
- **severity:** P2
- **vertical:** V9 (web client)
- **file:** `apps/web/app/routes/home.tsx:289-307`; `apps/web/app/components/features/home/MobileHome.tsx:351`
- **description:** The directory grid maps the entire grouped-merchant array (ADR 032: ~982 groups) into card components with no windowing (`react-window`/`@tanstack/react-virtual`/IntersectionObserver — zero matches in the tree). `loading="lazy"` defers off-screen image _bytes_ but not the ~982 DOM nodes + React reconciliation.
- **impact:** Large DOM, heavy first-render reconciliation, memory pressure on mobile/native webview.
- **fix:** virtualize the grid (`@tanstack/react-virtual`) or paginate sections; cheap CSS mitigation: `content-visibility: auto` on grid sections.
- **ref:** checklist §13 (LCP, memory). Web-agent corroborated.

### P2 — TanStack Query polls without terminal-state stop on payout/cashback cards

- **id:** PERF-009
- **severity:** P2
- **vertical:** V9 (web client)
- **file:** `apps/web/app/components/features/order/OrderPayoutCard.tsx:65` (30s); `PendingCashbackChip.tsx:84` (30s); `PendingPayoutsCard.tsx:36` (30s); `StellarTrustlineStatus.tsx:34` (60s)
- **description:** `refetchInterval` set to a fixed value with no predicate that returns `false` on a terminal payout state (`confirmed`/`failed`). Polls forever while mounted even after settlement.
- **impact:** Continuous background API polling per mounted card; the order-detail payout card polls a settled payout indefinitely. (`refetchIntervalInBackground` defaults false, so hidden tabs are spared.)
- **fix:** gate `refetchInterval` on a predicate (the pattern `LoopPaymentStep.tsx:42-46` uses correctly for the 3s payment poll — `return false` once terminal).
- **ref:** checklist §13 (refetch intervals without stop). Web-agent corroborated.

### P3 — 104 KB `hero.webp` preloaded but never painted (CSS-only hero)

- **id:** PERF-010
- **severity:** P3
- **vertical:** V9 (web client) / LCP
- **file:** `apps/web/app/routes/home.tsx:48`; asset `apps/web/public/hero.webp`
- **description:** `links()` emits `{ rel:'preload', as:'image', href:'/hero.webp' }` ("LCP candidate"), but the desktop hero is built from CSS (`bg-grid` + radial-gradient div, home.tsx:128-135). No `<img>`/`background-image` references `/hero.webp` anywhere in the rendered tree.
- **impact:** Every home visitor downloads 104 KB never displayed, competing for bandwidth with the real LCP element.
- **fix:** remove the dead preload (or wire `hero.webp` back as the actual hero background if intended).
- **ref:** checklist §13 (LCP/images). Web-agent corroborated.

### P3 — Render-blocking third-party Inter font on the critical path

- **id:** PERF-011
- **severity:** P3
- **vertical:** V9 (web client) / LCP
- **file:** `apps/web/app/root.tsx:228-233`
- **description:** Inter loaded as a render-blocking external stylesheet from `fonts.googleapis.com` with the full `100..900` axis; two preconnects but no font preload. `display=swap` mitigates FOIT (and ADR-005 §10 accepts this).
- **impact:** Render-blocking cross-origin request + extra DNS/TLS before text paints; FOUT swap shift.
- **fix:** self-host a latin-subset woff2 of the weights actually used + `<link rel="preload" as="font" crossorigin>`; drops two preconnects and the blocking CSS.
- **ref:** checklist §13 (fonts/LCP). Web-agent corroborated.

### P3 — CSV exporters buffer the full result set in memory (no streaming)

- **id:** PERF-012
- **severity:** P3
- **vertical:** V8 (admin)
- **file:** `apps/backend/src/admin/orders-csv.ts:118-171`; `user-credits-csv.ts:45-77`; and siblings (`payouts-csv.ts`, `user-credit-transactions-csv.ts`, etc.)
- **description:** Exporters are row-capped (`ROW_CAP=10_000`) but build the full row array then `join()` into one in-memory string before responding — the dataset is held ~twice per concurrent export. No streamed `Response`.
- **impact:** Fine at the 10k cap; memory spike if many exports run concurrently.
- **fix:** stream rows to the response (chunked) for the larger exports; or keep the cap and document the bound.
- **ref:** checklist §13 (unbounded/buffered result sets).

### P3 — Bundle budget reset to status-quo, no downward pressure

- **id:** PERF-013
- **severity:** P3
- **vertical:** V9 / CI
- **file:** `scripts/check-bundle-budget.sh:31-59`
- **description:** `MAX_SSR_KB=3300` (current ≈3040) and `MAX_CHUNK_KB=800` were reset to "reality + headroom" vs the documented 2500 KB target. The gate only catches new regressions, not existing bloat.
- **impact:** No ratchet toward the goal; the 540 KB Sentry chunk (PERF-004) sits inside budget.
- **fix:** after lazy-loading Sentry, ratchet `MAX_SSR_KB` down toward the 2500 target.
- **ref:** checklist §13.

---

## Non-findings (verified clean)

- **No N+1-over-DB-rows** anywhere in admin handlers — every loop iterates already-fetched rows for formatting/zero-fill only; `merchants-catalog-csv.ts:82-95` batches via a single `inArray` (PK-covered); `interest-mint-forecast.ts:106` loops ≤3 LOOP-asset Horizon calls (network, bounded). (admin-agent confirmed)
- **Public bulk cashback-rates** (`cashback-rate-handlers.ts:46-77`) is a single bulk `SELECT … WHERE active=true` — explicitly avoids per-merchant N+1; the per-merchant variant uses the PK.
- **Rate-limit map** is bounded (`RATE_LIMIT_MAP_MAX=10_000`, LRU-evict on insert) + hourly sweep (`rate-limit.ts:39-40,105-109,150-153`) — no unbounded growth.
- **Merchant store** is atomically replaced per refresh (`sync.ts:217`); `merchantsById`/`merchantsBySlug` rebuilt fresh each 6h tick — no leak; lookups are O(1) Map gets.
- **All workers** use `setInterval(...).unref()`, idempotent ticks, swallow per-tick errors, `markWorkerTickFailure` on failure (payout-worker, watcher-bootstrap, procurement-worker, asset-drift-watcher) — no timer leak; cadences sane (payment 10s, procurement 5s, payout 30s, drift 300s, interest 24h). Payment-watcher heartbeat is a single-row touch per 10s tick (6 writes/min — negligible).
- **Watcher cursor reads/writes** are PK-keyed single-row ops; `findPendingOrderByMemo` uses `findFirst` (payment_memo lookup — see note below).
- **Sweep queries** (`transitions-sweeps.ts:60-66,105-110`) are covered by partial indexes `orders_procuring_procured_at` and `orders_pending_payment`.
- **`listClaimablePayouts`** (`pending-payouts.ts:90-108`) is LIMIT-bounded, ordered, served by `pending_payouts_state_created`.
- **Clusters use protobuf** correctly on the wire (web requests `Accept: application/x-protobuf`, `services/clusters.ts:39`); proto module is lazy-imported (`handler.ts:122-125`) — Node caches the dynamic import after first call, so it's a one-time cold cost, not per-request. (not a finding)
- **statement_timeout** is applied as a connection startup parameter for direct-postgres (`db/client.ts:51-66`); correctly skipped for PgBouncer/pooler hosts. **Pool sizing** `DATABASE_POOL_MAX` (default 10), `idle_timeout: 20`, `connect_timeout: 10` — reasonable for single-machine launch volume. Note: on pooler hosts `statement_timeout` protection is omitted (documented limitation, client.ts:24-33) — a long query could hold a connection without the per-session cap.

## Open items to verify (not blockers)

- `findPendingOrderByMemo` (`orders/repo.ts:224`) filters on `payment_memo` for pending orders — confirm an index exists on `(payment_memo)` or `(state, payment_memo)`; the schema shows no index on `payment_memo`. Called per matching deposit in the watcher; at low deposit volume a seq scan of pending-only rows is cheap, but worth an index `orders(payment_memo) WHERE state='pending_payment'` for the deposit hot path. (Assumption: pending set is small; flag as P3 if confirmed missing.)

---

## Coverage

DB: read `db/schema.ts` (all 14 tables + every index/constraint), `db/client.ts` (pool +
statement_timeout). Cross-referenced every admin handler's WHERE/ORDER BY/GROUP BY against
the index set (via sub-agent enumeration of `admin/*.ts`, spot-verified treasury, cashback-
stats, flywheel-stats, liabilities, pending-payouts, transitions-sweeps). Backend hot paths:
clustering (algorithm + data-store + handler), merchant sync/store/handler, cashback-rate
handlers, rate-limit middleware. Workers: payment-watcher (+ bootstrap), payout-worker,
procurement-worker (+ bootstrap), asset-drift-watcher — tick cadence, per-tick query cost,
timer hygiene, backoff. Web (via sub-agent + spot-checks): bundle budget script + sizes,
code-split inventory, all `refetchInterval`/focus flags, root prefetch, fonts/hero/LCP,
protobuf-on-wire, virtualization. Memory: rate-limit map cap, merchant/location store
lifecycle, in-memory drift state. NOT separately deep-dived (lower perf surface): interest-
pool-watcher internals, mobile webview perf, individual openapi modules, sep7/stroops math.

## Summary

13 findings: 0 P0, 5 P1, 4 P2, 4 P3. The two highest-impact server-side items are
PERF-001 (public cashback-stats runs 3 unwindowed full-table aggregates per recompute with
no compute cache + missing `type` index) and PERF-002 (cluster handler re-scans the full
~116k-location array on every request — no spatial index). The cross-cutting DB theme
(PERF-005/006) is the absence of plain `created_at` indexes on `orders`/`credit_transactions`
plus non-sargable `::date`/`DATE_TRUNC` joins, which makes the admin dashboard/CSV time-
series and treasury views seq-scan growing tables. Web: PERF-003 (full catalog prefetched +
focus-refetched on every route) and PERF-004 (~540 KB Sentry in the root chunk) are the two
biggest client wins. No N+1, no unbounded maps, no timer leaks; workers and pool sizing are
sound for launch volume. Nothing here is a launch blocker — all are cliffs that bite as the
ledger/catalog/traffic grow, fixable with indexes, a compute-cache TTL, query windowing, and
a Sentry lazy-import.
