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

| Surface              | Threshold                                   | Paging                                                       |
| -------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| Stuck order          | > 15 min in `procuring` or `paid`           | Discord `monitoring` via `notifyStuckProcurementSwept` sweep |
| Stuck payout         | > 30 min in `submitted` without `confirmed` | Discord `monitoring`                                         |
| Operator pool health | ≥ 1 operator in `closed` state              | Discord `monitoring` via `notifyOperatorPoolExhausted`       |
| USDC reserve floor   | `balance < LOOP_USDC_FLOOR_STROOPS`         | Discord `monitoring` via `notifyUsdcBelowFloor`              |

The admin UI slider (5 / 15 / 60 min on `stuck-orders`) is
**exploratory** — ops uses narrower windows for triage. The 15-min
paging threshold is the documented default that the sweep worker
enforces.

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

## Error-budget policy (informal, Phase 1)

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

This is informal on purpose — formalising an error-budget policy
before we have any traffic to measure against is process for its
own sake. Revisit when Phase 2 sign-off is being prepared.

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
