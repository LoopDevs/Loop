---
title: Loop service-level objectives
---

# Loop service-level objectives

> Closes A2-1325. Prior to this document the word "SLO" appeared
> 40+ times in admin-route names and code comments (e.g. `/admin/stuck-orders`,
> `notifyStuckProcurementSwept`, `past-SLO` log-line comments) without a
> single concrete number attached. Operators reading a "past-SLO" log
> line had no way to answer "past-SLO by how much?" because no SLO
> was ever pinned.

Loop is pre-launch. These targets are **aspirational commitments we
accept as the definition of "healthy"**, not post-hoc measurements
of current behaviour. Re-evaluated at each phase gate; revised in an
ADR when real traffic reshapes the right number.

## How to read this doc

For each user-facing flow we pin:

1. **SLI** — the service-level indicator. The measurable signal.
2. **Target** — the SLO itself. What "healthy" means numerically.
3. **Window** — the rolling measurement window.
4. **Error budget** — implied by `(1 − target) × window`.
5. **Escalation surface** — where a breach becomes visible.

An SLO is a contract with ourselves about what "degraded" means. A
breach doesn't mean we page ops for every missed target — it means
the error budget is shrinking, and when it's gone we stop shipping
new features until the trend reverses. For Phase 1 the error-budget
policy is informal: Loop's three most recent operators discuss and
decide. Formalising is a Phase-2 follow-up once we have enough
traffic to sample meaningfully.

## Availability

| Flow                      | SLI                                                                  | Target | Window | Surface                                     |
| ------------------------- | -------------------------------------------------------------------- | ------ | ------ | ------------------------------------------- |
| `/api/*` 2xx rate         | non-5xx responses / total (excluding 401/403/404/422/429 user-space) | 99.5 % | 30d    | Fly healthcheck + `notifyHealthChange`      |
| `/api/public/*` 2xx rate  | non-5xx responses / total                                            | 99.9 % | 30d    | never-500 contract + Cache-Control CDN-safe |
| `/api/admin/*` 2xx rate   | authenticated admin requests returning 2xx / 5xx                     | 99.0 % | 30d    | Discord `admin-audit` + Sentry              |
| CTX upstream reachability | `/status` probe success rate (`probeUpstream` in `app.ts`)           | 99.0 % | 7d     | `/health` flap-damper, Discord `monitoring` |

Error budget for `/api/*` at 99.5 % / 30d = 0.5 % of requests, i.e.
if a single rogue handler burns the entire 30d budget in one bad
deploy, the budget-burn alert should fire within the same rolling
window.

## Latency

| Flow                      | SLI                              | Target                   | Window | Surface                                             |
| ------------------------- | -------------------------------- | ------------------------ | ------ | --------------------------------------------------- |
| `/api/merchants` (cached) | p95 duration                     | ≤ 200ms                  | 7d     | access log `durationMs`                             |
| `/api/orders` create      | p95 round-trip (client-observed) | ≤ 1500ms                 | 7d     | access log + web `forwardQueryErrorToSentry` on 5xx |
| `/api/admin/treasury`     | p95 duration                     | ≤ 800ms                  | 7d     | access log                                          |
| CTX `/status` probe       | p95 response time                | ≤ 3 seconds (5s timeout) | 24h    | `probeUpstream` cache + Discord health              |

## Freshness — background data the app shows

| Data                          | SLI                                         | Target                                       | Window      | Surface                         |
| ----------------------------- | ------------------------------------------- | -------------------------------------------- | ----------- | ------------------------------- |
| Merchant catalog              | `getMerchants().loadedAt` age               | ≤ 2× `REFRESH_INTERVAL_HOURS` (12h)          | per-machine | `/health` `merchantsStale` flag |
| Location clusters             | `getLocations().loadedAt` age               | ≤ 2× `LOCATION_REFRESH_INTERVAL_HOURS` (48h) | per-machine | `/health` `locationsStale` flag |
| Cashback realization snapshot | `/api/admin/cashback-realization` query age | point-in-time (reads live)                   | n/a         | admin UI timestamp              |

The merchant / location freshness gates are already hard-wired in
`/health` — a stale read flips the probe to `degraded` regardless of
the rolling SLI. The SLO values above match the existing 2× refresh
window so the doc and the code agree.

## Admin-operational targets — "stuck-X" thresholds

These are the numbers `admin.stuck-orders.tsx` / `admin.stuck-payouts.tsx`
were hinting at without ever pinning:

| Surface              | Threshold                           | Paging                                                       |
| -------------------- | ----------------------------------- | ------------------------------------------------------------ |
| Stuck order          | > 15 min in `procuring` or `paid`   | Discord `monitoring` via `notifyStuckProcurementSwept` sweep |
| Stuck payout         | > 5 min in `pending` or `submitted` | Discord `monitoring` via `notifyStuckPayouts`                |
| Operator pool health | ≥ 1 operator in `closed` state      | Discord `monitoring` via `notifyOperatorPoolExhausted`       |
| USDC reserve floor   | `balance < LOOP_USDC_FLOOR_STROOPS` | Discord `monitoring` via `notifyUsdcBelowFloor`              |

The admin UI slider (5 / 15 / 60 min on `stuck-orders`) is
**exploratory** — ops uses narrower windows for triage. The 15-min
paging threshold is the documented default that the sweep worker
enforces. `/health` now also exposes `otpDelivery` and per-worker
state so auth-delivery failures and money-moving worker stalls show up
as first-class degraded signals instead of log-only symptoms.

## Settlement (ADR 015)

| Flow                              | SLI                                          | Target  | Window | Surface                                                    |
| --------------------------------- | -------------------------------------------- | ------- | ------ | ---------------------------------------------------------- |
| Cashback credit → Stellar confirm | `pendingPayouts.confirmedAt - createdAt` p95 | ≤ 5 min | 24h    | `/api/admin/payouts/settlement-lag` (A2-1506 shared shape) |
| Order `paid → fulfilled`          | `orders.fulfilledAt - paidAt` p95            | ≤ 2 min | 24h    | `admin/operator-latency`                                   |

## On-chain asset drift

| Flow                    | SLI                                           | Target                      | Window           | Surface                    |
| ----------------------- | --------------------------------------------- | --------------------------- | ---------------- | -------------------------- |
| USDLOOP drift vs ledger | `onChainStroops - ledgerLiabilityMinor × 1e5` | `\|drift\| ≤ 100 USD equiv` | per-tick watcher | `notifyAssetDrift` Discord |
| GBPLOOP drift vs ledger | same, GBP                                     | `\|drift\| ≤ 100 GBP equiv` | per-tick watcher | `notifyAssetDrift` Discord |
| EURLOOP drift vs ledger | same, EUR                                     | `\|drift\| ≤ 100 EUR equiv` | per-tick watcher | `notifyAssetDrift` Discord |

These are SAFETY targets, not soft-fail SLOs. Any breach should
block issuance until drift is explained (in-flight payout or bug).

## Error-budget policy (informal, Phase 1) — A2-1920

When an availability or latency target burns >50 % of its budget
inside the window:

1. The operators who touched code in the offending area pause
   feature work until the burn rate flattens.
2. A short RCA document (not an ADR — an RCA lives in
   `docs/rca/` when we introduce that directory) captures what
   happened, what the fix was, and what would have caught it
   earlier.
3. If the budget is exhausted, a Phase-2 follow-up is filed to
   harden the area.

**A2-1920 — burn-rate review cadence.** Until a continuous-tracking
dashboard is wired (Phase 2 alongside A2-1318 Prometheus + A2-1324
RUM), the on-call performs a manual burn-rate snapshot at three
junctures:

- **Weekly Monday review.** On-call pulls the access-log derived
  per-route 5xx rate from `/metrics` (or, post-A2-1318, the live
  Prometheus snapshot) and computes "% of 30d budget consumed so
  far." Posts the line to `#deployments` as part of the
  Monday-handoff thread (A2-1901). Three consecutive weeks above
  20 % budget consumed → file a hardening ticket.
- **Per-incident.** Every P0/P1 incident post-mortem includes the
  pre/post-incident error-budget delta. A single P0 that consumes
  > 25 % of 30d budget warrants a "could this have been prevented
  > earlier" pass even when the immediate fix is straightforward.
- **Quarterly.** Aggregate the 12 weekly snapshots into a phase
  exit / re-target review — drop targets that are routinely
  overshot, raise ones that are routinely undershot, retire SLIs
  that turn out not to predict user pain.

This stays informal on purpose — formalising an error-budget
process before we have continuous tracking is process for its own
sake. Revisit when Phase 2 sign-off is being prepared.

## Capacity, headroom, and spike plan — A2-1919

Phase-1 traffic is "tens of orders per day." This section pins the
**known capacity ceilings** so a sudden spike isn't a surprise, and
the **next-step lever** for each surface when steady-state traffic
approaches one.

| Surface                          | Phase-1 ceiling                                                                                         | Next-step lever (Phase 2 / 3)                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend Fly machines             | 1× shared-cpu-1x at launch; ~200 r/s ceiling per machine                                                | Horizontal scale via `fly scale count`; the in-memory rate-limiter is per-process so scaling out widens the per-IP ceiling — accept that, or move to a Redis-backed limiter. |
| Postgres connections             | Drizzle pool max default 10; Fly Postgres `max_connections` typically 100                               | Bump `DATABASE_POOL_MAX` first; PgBouncer (transaction mode) only after the ledger primitives are reviewed for compatibility (ADR 009 `FOR UPDATE` semantics).               |
| Stellar payout-worker throughput | ~1 tx / 5s per operator (sequence-number serialisation; ADR 016)                                        | Add multi-signer parallelism (multiple operator accounts); per-asset workers; pull `/fee_stats` before each batch (currently in A2-1921 fee-bump path).                      |
| CTX operator pool                | 1 operator at minimum, 2+ recommended (ADR 013 `CTX_OPERATOR_POOL`); rate-limit ceiling unknown to Loop | Provision more operators; coordinate with CTX ops on per-operator quota.                                                                                                     |
| Discord webhook rate             | 30 req/min per webhook (Discord docs) — current notifiers + dedup well inside this                      | A2-1326 dedup already throttles flap; Phase-2 Pager tier (A2-1927) takes the high-priority surface off Discord entirely.                                                     |
| Frankfurter FX feed              | 1 r/min per source (free tier); cached daily in price-feed module                                       | Move to a paid feed if the daily cache miss rate climbs.                                                                                                                     |
| Image proxy                      | 300 r/min per IP × N machines × Fly egress quota                                                        | Per-host CDN cache for merchant logo / card-image URLs (Cloudflare in front of `/api/image`).                                                                                |
| Frontend bundle delivery         | Vercel / Fly static-host CDN; budget per route checked by `scripts/check-bundle-budget.sh` (A2-1711)    | Lazy-load admin routes (large), service-worker pre-cache, etc.                                                                                                               |

**Spike plan.** A sudden 10× traffic burst at Phase 1 (e.g. a
viral social post) hits the rate-limit + circuit-breaker walls
first, not the capacity walls. Procedure:

1. **Watch the on-call channel** for `notifyHealthChange` and
   `notifyOperatorPoolExhausted` — those fire before user pain is
   visible.
2. **Loosen the impacted rate-limit** following the
   "Rate-limit review cadence (A2-1918)" loosen-when-in-doubt
   default. Push the env change via `fly secrets set` — no redeploy.
3. **Scale machines horizontally** (`fly scale count 3`) if the
   per-machine ceiling is being approached; the in-memory limiter
   then operates per-process which trades attack-surface for
   capacity (acceptable during a burst).
4. **Don't lift the kill switches** (A2-1907) unless the alternative
   is full collapse — partial failure is preferable to corrupted
   ledger state.

Every quarter (paired with the rate-limit review cadence above),
revisit this table against actual measured traffic and update
ceilings.

## Third-party quota + cost alerts — A2-1916

Loop's outbound dependencies have quota or cost ceilings that Loop
can hit silently if usage scales:

| Vendor                           | Quota / ceiling                                                | Cost surface                                                 | Detection                                                                                                              |
| -------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **Anthropic (Claude PR review)** | Per-month token budget (set in Anthropic console)              | Tokens per PR review × open PRs                              | Anthropic console threshold alerts at 50 % / 80 % / 100 % monthly; `pr-review.yml` `concurrency` group caps in-flight. |
| **Sentry (errors + tracing)**    | Per-month event quota (free tier 5k errors / 10k transactions) | Per-error + per-tx; tracing sampled at 10 % in prod          | Sentry quota alert email + dashboard; `tracesSampleRate: 0.1` already accepts dropped tx.                              |
| **Discord (webhook posts)**      | 30 req/min per webhook (rate limit, not cost)                  | Free                                                         | Discord 429 → log warn in `discord.ts::sendWebhook`; A2-1326 dedup already throttles.                                  |
| **Fly.io (machines + Postgres)** | Per-org spend cap; per-machine resource quota                  | Per-machine-hour + Postgres GB                               | Fly billing dashboard; `flyctl orgs auto-suspend` cap.                                                                 |
| **Stellar (Horizon polling)**    | Free tier rate limit; horizon.stellar.org accepts ~100 req/sec | Free                                                         | Watcher tick interval well inside ceiling; `notifyCircuitBreaker` fires per-endpoint if rate-limited.                  |
| **Frankfurter (FX rate feed)**   | Free, no documented quota                                      | Free                                                         | Internal cache; cache miss → log warn; A2-1812 zod validation catches shape drift.                                     |
| **Google OAuth / Apple OAuth**   | Free tier high quota                                           | Free                                                         | Per-attempt `audience` + `iss` validation; A2-1915 schema-drift alert fires on response shape change.                  |
| **CTX upstream**                 | Per-operator rate limit (unknown to Loop — ask CTX ops)        | Wholesale per gift card (the actual cashback business model) | Reconciliation A2-1914 catches volume mismatch monthly.                                                                |

**Operator action.** Each vendor's billing-side alerts are
provisioned **once** (not per deploy) and live in 1Password
alongside the credential. The single-maintainer Phase-1 stance
relies on those vendor-side alert emails landing in the
operator inbox; a Phase-2 follow-up consolidates them into a
unified spend dashboard.

## Where these numbers came from

- Availability: conservative relative to CTX's own SLA (99.0 %)
  so Loop is not the bottleneck.
- Latency: rounded up from current dev-machine measurements of the
  integration test suite; will be sharpened with prod data.
- Freshness: 2× refresh interval matches the live `/health` gate.
- Settlement: Stellar mainnet block time is ~5s; a 5-minute target
  leaves headroom for Horizon confirmation lag + our internal
  queue.
- Drift: safety-critical, not latency-critical — the number is
  chosen low enough that any real drift shows up before it becomes
  a compliance question.

Each of the above is a number we believe we can hit **at the rate
of traffic we expect during Phase 1 (tens of orders/day)**.
Re-evaluate at every phase gate.

## Rate-limit review cadence (A2-1918)

The per-IP rate-limit values in `apps/backend/src/app.ts` (and
documented in `AGENTS.md` § Backend middleware stack) are
**intuition-derived for Phase 1**. The exit door:

| Cadence                            | What                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Post-launch + 30d**              | First measurement-driven review. On-call pulls `/metrics` scraped counters (or, post-A2-1318 Phase-2, a Prometheus snapshot) for every gated route and compares 429-rate vs request-rate. Any route emitting >0.5% 429s under steady-state traffic is too tight; loosen. |
| **Quarterly**                      | Repeat the review. Drop or raise per-route limits based on the prior quarter's data; commit the new values + the measurement source as a tracker note. No ADR per change — the ADR is this section pinning the cadence.                                                  |
| **On every PR adding a new route** | The PR author picks a starting limit using the route's nearest analogue from the existing table as their seed. Reviewer sanity-checks. Re-evaluation lands in the next quarterly review.                                                                                 |

If a rate-limit incident fires (a real-traffic 429-spike that
flagged real users): treat it as a P2, raise the offending limit
in the same on-call window, document in the post-incident summary.
Don't wait for the quarterly review to fix a known gap.

The live limit table for review lives in `AGENTS.md` § Backend
middleware stack (single source of truth — don't duplicate).

**Default action when in doubt: loosen, don't tighten.** Tightening
a rate limit can lock real users out; loosening one only re-exposes
the attack surface that the request-validators + circuit breakers

- auth gating already cover. The 429 layer is defence-in-depth,
  not the primary control.

## Cross-reference

- ADR 015 — stablecoin reserve / liability invariant (drift SLO)
- ADR 018 — admin audit trail, the surface where "past-SLO" log
  lines reference these numbers
- `docs/architecture.md §Backend API endpoints` — maps every
  route to its latency target
- `apps/backend/src/admin/settlement-lag.ts` + the A2-1506 shared
  shapes back the Settlement SLI data feed
- `apps/backend/src/admin/stuck-orders.ts` /
  `apps/backend/src/admin/stuck-payouts.ts` — admin UI that
  surfaces breaches against the "admin-operational" thresholds above
