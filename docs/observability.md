---
title: Observability — metrics, scraping, dashboards
---

# Observability — metrics, scraping, dashboards

> Closes the 🟢 code/config half of readiness-backlog **B-5** /
> go-live-plan §T1-BS **B-5** ("observability depth"). A4-048 already
> gave Loop a real Prometheus-format `/metrics` endpoint; nothing
> before this doc actually scraped it, dashboarded it, or mapped its
> series to the SLOs in `docs/slo.md`. The 👤 half — standing up a
> real Prometheus + Grafana instance and wiring OpenTelemetry tracing
> / a paging tier — is **not** done by this doc; see "Operator
> actions" below and the still-open tracing/paging half of B-5 in
> `docs/readiness-backlog-2026-07-03.md`.

## What's emitted

`GET /metrics` (`apps/backend/src/observability-handlers.ts`) serves
Prometheus text-exposition format. Everything below is in-memory
state — no DB or upstream call happens on a scrape (the catalog /
geo-DB reads are cache lookups; the geo-DB reader itself is memoized
after first open) — so scrape frequency doesn't add load beyond the
handler itself.

| Metric                                             | Type      | Labels                         | Backs                                                                                                                                                                                          |
| -------------------------------------------------- | --------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loop_requests_total`                              | counter   | `method,route,status`          | Availability SLO (5xx rate) — `docs/slo.md` §Availability                                                                                                                                      |
| `loop_request_duration_seconds_{bucket,sum,count}` | histogram | `method,route[,le]`            | Latency SLO (p95 per route) — `docs/slo.md` §Latency (A4-048)                                                                                                                                  |
| `loop_rate_limit_hits_total`                       | counter   | —                              | 429 volume; pairs with the rate-limit review cadence (A2-1918)                                                                                                                                 |
| `loop_rate_limit_fleet_estimate`                   | gauge     | —                              | S4-4's per-machine → fleet-wide budget divisor                                                                                                                                                 |
| `loop_rate_limit_fleet_estimate_source`            | gauge     | —                              | 0=static fallback, 1=dynamic DNS-derived (mirrors `/health`'s equivalent field)                                                                                                                |
| `loop_circuit_state`                               | gauge     | `endpoint`                     | 0=closed, 1=half_open, 2=open — per-upstream circuit breakers                                                                                                                                  |
| `loop_runtime_surface_degraded`                    | gauge     | `surface="otp_delivery"`       | OTP-delivery health                                                                                                                                                                            |
| `loop_worker_running`                              | gauge     | `worker`                       | Worker liveness                                                                                                                                                                                |
| `loop_worker_degraded`                             | gauge     | `worker`                       | Worker degraded state                                                                                                                                                                          |
| `loop_worker_stale`                                | gauge     | `worker`                       | Worker staleness (past its `staleAfterMs` budget) — added B-5                                                                                                                                  |
| `loop_worker_last_success_timestamp_ms`            | gauge     | `worker`                       | Liveness timestamp (emitted only once non-null)                                                                                                                                                |
| `loop_worker_last_lead_tick_timestamp_ms`          | gauge     | `worker`                       | S4-8's "actually did the work" timestamp — distinguishes a fleet that's alive-but-never-leading (wedged) from a healthy one. Added B-5.                                                        |
| `loop_catalog_loaded_timestamp_ms`                 | gauge     | `catalog=merchants\|locations` | Freshness SLO source data — added B-5                                                                                                                                                          |
| `loop_catalog_stale`                               | gauge     | `catalog=merchants\|locations` | Freshness SLO breach flag (same 2x-refresh-interval formula as `/health`, single source of truth in `health.ts`'s `merchantCatalogStaleAfterMs()`/`locationCatalogStaleAfterMs()`) — added B-5 |
| `loop_geo_db_stale`                                | gauge     | —                              | GeoLite2 `.mmdb` staleness (go-live-plan §T1-F); false both when fresh AND when unconfigured — added B-5                                                                                       |
| `loop_geo_db_build_age_days`                       | gauge     | —                              | Age of the loaded `.mmdb` build; omitted entirely when no DB is configured — added B-5                                                                                                         |

**Not emitted as metrics** (deliberately, so nothing in the dashboard
below panels a metric the code doesn't actually produce):

- **Settlement lag** (`docs/slo.md` §Settlement — cashback-credit → Stellar
  confirm, order `paid → fulfilled`) lives behind
  `apps/backend/src/admin/settlement-lag.ts` / `admin/operator-latency.ts`,
  which run a live DB query per request. Wiring these into the
  in-memory `/metrics` handler would turn every Prometheus scrape into
  a DB read — a real architectural change, not a small additive one.
  Until that's done, pull these from the admin UI / `GET
/api/admin/payouts/settlement-lag`.
- **On-chain asset drift** (`docs/slo.md` §On-chain asset drift) is
  computed by the `asset-drift-watcher` and persisted
  (`asset-drift-state-repo.ts`) + paged to Discord
  (`notifyAssetDrift`) already — it isn't exported as a `/metrics`
  gauge yet. A future small PR could stash the watcher's last-computed
  per-asset drift into an in-memory snapshot the same way
  `runtime-health.ts` does for workers; not done here to keep this PR
  scoped to genuinely additive, already-in-memory signals.

## Auth — scraping needs a bearer token

`/metrics` is gated by `probeGateAllows()`
(`apps/backend/src/middleware/probe-gate.ts`), same as `/openapi.json`:

- **Production**: closed by default. Set `METRICS_BEARER_TOKEN` and the
  scraper must send `Authorization: Bearer <token>`; wrong/missing → 401. If the env var is unset in production, the route 404s (so a
  probe can't even fingerprint that `/metrics` exists).
- **Development / test**: open, no token required.

This means a real Prometheus scrape config MUST authenticate. See
`docs/observability/prometheus.yml`.

## Dashboards-as-code + scrape-config-as-code

Two committed, versioned artifacts under `docs/observability/`:

- **`docs/observability/prometheus.yml`** — an example scrape config
  pointed at `GET /metrics` with bearer auth wired via
  `authorization.credentials_file` (never commit the token itself).
  Validated locally with `promtool check config
docs/observability/prometheus.yml` (promtool isn't a repo dependency
  — install it separately if you want to re-validate: `brew install
prometheus` on macOS, or download from
  https://prometheus.io/download/).
- **`docs/observability/grafana-dashboard.json`** — a Grafana
  dashboard (schema v39, standard shareable-export format with a
  `${DS_PROMETHEUS}` datasource input prompted on import) with panels
  grouped into four rows that map directly onto `docs/slo.md`:
  - **Availability** — 5xx rate by route.
  - **Latency** — p95 request duration by route, annotated with the
    per-route targets from `docs/slo.md` §Latency.
  - **Freshness** — catalog staleness + age (merchants/locations),
    GeoLite2 DB staleness + build age.
  - **Worker health** — running/degraded/stale table, plus a panel
    that plots liveness age against lead-tick age so a wedged-but-
    alive fleet (S4-8) is visible, not just a fully-dead one.
  - **Infra** — circuit-breaker state, rate-limit 429 rate + fleet
    estimate, OTP-delivery degraded flag.

Both files parse-checked in CI: `scripts/lint-docs.sh` §11 asserts the
dashboard JSON is valid; `npm run verify` runs it. There's no
automated `promtool` check in CI (it isn't a repo dependency and isn't
guaranteed present on the runner) — re-run it locally after editing
`prometheus.yml`.

## Operator actions (👤, not done by this doc)

Standing up a real Prometheus + Grafana instance is out of scope for
a code/config PR — it's infra provisioning + ongoing hosting cost.
When ready:

1. **Pick a host.** Either a small Fly machine running Prometheus +
   Grafana (co-located with the backend, simplest network path to
   `/metrics`), or a managed target (Grafana Cloud's free tier accepts
   remote-write and ships its own Grafana — no self-hosting).
2. **Set `METRICS_BEARER_TOKEN`** on the Loop backend (`fly secrets
set METRICS_BEARER_TOKEN=$(openssl rand -hex 32) -a
loopfinance-api`). Put the same value in the scrape config's
   `credentials_file` (never commit it).
3. **Point Prometheus at `docs/observability/prometheus.yml`**,
   substituting the real host + token-file path.
4. **Import `docs/observability/grafana-dashboard.json`** into
   Grafana, selecting the new Prometheus datasource when prompted.
5. **Revisit `docs/alerting.md`'s Phase-2 paging plan.** Burn-rate
   alerting (A2-1920) and OpenTelemetry tracing across the
   order → payment-watcher → procurement → payout chain are the
   remaining B-5 scope (readiness-backlog `[operator]`-tagged pieces
   for vendor choice, `[code]` for the actual OTel spans + PagerDuty/
   Twilio wiring) — not addressed by this PR.

## Cross-reference

- `docs/slo.md` — the targets every panel above maps to.
- `docs/alerting.md` — the paging-tier gap this doc's tracing/burn-rate
  follow-up would close.
- `apps/backend/src/observability-handlers.ts` — the `/metrics`
  emitter.
- `apps/backend/src/metrics.ts` — the counter/histogram state module.
- `apps/backend/src/runtime-health.ts` — the worker/OTP state backing
  the worker gauges.
- `apps/backend/src/health.ts` — `merchantCatalogStaleAfterMs()` /
  `locationCatalogStaleAfterMs()`, the single source of truth for the
  freshness threshold shared with `/health`.
