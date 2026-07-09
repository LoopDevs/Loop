---
title: Loop load / stress testing
---

# Loop load / stress testing

> Closes the harness half of readiness-backlog **B-1** / go-live-plan
> §T1-BS **B-1** ("load/stress/soak testing (absent)"). Before this doc
> there was zero capacity evidence for a payment system running on a
> single 512MB/1-shared-cpu Fly VM (`apps/backend/fly.toml`) — no k6 or
> artillery suite existed anywhere in the repo.

## What this is — and isn't

This is a **k6 load-test harness** (`tools/load-test/`) that drives the
same self-contained mocked stack the `test-e2e-mocked` CI job boots
(mock-ctx + backend + real Postgres — see `playwright.mocked.config.ts`)
at increasing concurrency, and a GitHub Actions workflow
(`.github/workflows/load-test.yml`) that runs it on demand.

**It is not** a production capacity number. See "What this does NOT
cover" below before treating any number on this page as a launch
go/no-go signal.

## Scenarios

Both scripts live in `tools/load-test/` and share `config.js` (base URL
resolution, the common < 1% error-rate threshold, and `scaleStages()` for
the `VUS_SCALE` knob).

### `browse.js` — anonymous browse traffic

Staged ramp **5 → 50 → 100 VUs** over ~4 minutes (`30s→5, 1m→50, 2m→100,
30s→0`). Each iteration:

1. `GET /api/clusters` with a realistic bbox (continental-US viewport,
   `zoom=10`) — exercises `apps/backend/src/clustering/handler.ts`'s
   full parse/validate/bbox-expand/filter/cluster path. mock-ctx's
   `/locations` fixture is seeded empty, so this always returns an empty
   cluster set locally — it's still the right shape to point at a
   populated catalog (staging/prod) later.
2. `GET /api/merchants/all?fields=lite` — the whole-catalog browse read.
3. `GET /api/merchants/by-slug/:slug` for a random slug from the mock
   seed catalog (`amazon` / `target` / `starbucks`).

Thresholds: `http_req_duration{name:merchants_all}` and
`{name:merchants_by_slug}` both `p(95)<200ms` (docs/slo.md's `/api/merchants`
(cached) SLO), plus the shared `http_req_failed`/`errors` rate `<1%`.

### `auth-order.js` — full auth → order journey

Lower, write-path-appropriate staged ramp **2 → 10 → 25 VUs** over ~4
minutes (`30s→2, 1m→10, 2m→25, 30s→0`). Each iteration:

1. `POST /api/auth/request-otp` — unique-per-iteration email
   (`k6-load-vu<N>-iter<N>-<ts>@load.test`).
2. `POST /api/auth/verify-otp` with the mocked stack's hardcoded OTP
   (`123456` — `tests/e2e-mocked/fixtures/mock-ctx.mjs`), extracting
   `accessToken`.
3. `POST /api/orders` (legacy CTX-proxy create path) with a random
   merchant from the mock catalog. **Response is `201` with
   `{ orderId, paymentUri, paymentAddress, xlmAmount, memo, expiresAt }`**
   — note the field is `orderId`, not `id` (the backend reshapes
   mock-ctx's own `{ id, ... }` record before responding to the client).
4. `GET /api/orders/:id` twice, 1s apart, mirroring the frontend
   PaymentStep's poll cadence. Response is `{ order: { id, ... } }`.

Both auth calls take the backend's **legacy CTX-proxy path** — the
mocked stack (`playwright.mocked.config.ts`) deliberately leaves
`LOOP_AUTH_NATIVE_ENABLED` unset so the home page's SSR branch matches
the existing mocked-e2e Playwright suite, which means
`apps/backend/src/auth/handler.ts`'s `requestOtpHandler` /
`verifyOtpHandler` forward to mock-ctx's `POST /login` / `POST
/verify-email` rather than the Loop-native OTP path.

Threshold: `http_req_duration{name:order_create}` `p(95)<1500ms`
(docs/slo.md's `/api/orders` create SLO), plus the shared error-rate
budget.

### `config.js`

- `BASE_URL` (env `BASE_URL`, default `http://localhost:8081`).
- `COMMON_THRESHOLDS` — `http_req_failed` and the custom `errors` Rate
  metric, both `<1%`, layered under each script's own SLO threshold.
- `scaleStages(stages)` — multiplies every stage's VU `target` by
  `__ENV.VUS_SCALE` (default `1`). This is what the GitHub Actions
  workflow's `vu_scale_factor` dispatch input drives.

## Running locally

```bash
# Full run — boots postgres (docker compose), mock-ctx, and the backend
# (NODE_ENV=test, DISABLE_RATE_LIMITING=1), waits for health, then runs
# both scenarios via a pinned k6 Docker image. Tears down only the
# node processes it started (mock-ctx + backend); leaves the shared
# docker-compose postgres running.
./tools/load-test/run-local.sh              # both scenarios
./tools/load-test/run-local.sh browse       # one scenario
./tools/load-test/run-local.sh auth-order

# Faster/lighter pass (e.g. checking the harness itself works):
VUS_SCALE=0.2 ./tools/load-test/run-local.sh browse

# Fallback if docker-run-k6 is flaky on your machine — `brew install k6`
# then run natively on the host instead of via Docker:
K6_BIN=k6 ./tools/load-test/run-local.sh
```

k6 is a Go binary, not an npm package — there is no `package.json`
dependency and therefore **no ADR** for it (per the readiness-backlog B-1
item's own note). `run-local.sh` defaults to a pinned-by-digest
`grafana/k6` Docker image (same convention as the `trivy`/`gitleaks`
jobs in `.github/workflows/ci.yml`), with a PATH-installed `k6` binary
(`K6_BIN=k6`) as the documented fallback.

Summaries land in `tools/load-test/results/*-summary.json`
(git-ignored — regenerated per run).

### macOS / Docker Desktop networking

`docker run --network host` does **not** reach the host's localhost
ports on Docker Desktop for Mac — the daemon runs containers inside a
Linux VM with its own network namespace, unlike a real Linux Docker
host where `--network host` puts the container directly on the host's
network stack. Verified locally (Docker Desktop 28.3, macOS): the flag
is silently accepted but the container can't reach `127.0.0.1` on the
host.

`run-local.sh` handles this by:

- Only passing `--network host` on Linux (matches the `ubuntu-latest`
  CI runner in `.github/workflows/load-test.yml`, where it works
  normally).
- On darwin, pointing `BASE_URL` at `http://host.docker.internal:8081`
  instead — Docker Desktop resolves that hostname to the host for you.
  Confirmed working: `docker run --rm curlimages/curl ... 
http://host.docker.internal:8081/health` → `200`.

Override with `BASE_URL=...` if your setup needs something else.

### `run-local.sh` and bash 3.2

macOS ships bash 3.2 (Apple avoids the GPLv3 license on 4.x+), which
mishandles `"${arr[@]}"` on an **empty** array under `set -u` — it
raises `unbound variable` instead of expanding to nothing. This bit the
first version of `run-local.sh`'s `--network host` flag (built as a
conditionally-empty array) during local verification; the script now
branches into two near-identical `docker run` invocations instead of
building an array, specifically so it keeps working on the exact
environment (`#!/usr/bin/env bash` on a stock macOS laptop) it's meant
for.

## Running via GitHub Actions

`.github/workflows/load-test.yml` is **`workflow_dispatch`-only** — it
is a capacity-measurement harness, not a correctness gate, and is
**deliberately not one of the five required status checks** on `main`
(`Quality`, `Unit tests`, `Security audit`, `Build verification`, `E2E
tests (mocked CTX)` — see `AGENTS.md` §Git workflow). A load-test run
failing its thresholds should not block an unrelated PR from merging.

Trigger from the Actions tab or:

```bash
gh workflow run load-test.yml -f scenario=both -f vu_scale_factor=1
```

Inputs:

- `scenario` — `browse` / `auth-order` / `both` (default `both`).
- `vu_scale_factor` — multiplies every scenario's staged VU targets
  (default `1`; e.g. `0.25` for a lighter pass on a shared CI runner).

The job boots the same stack as `run-local.sh` (postgres service
container, mock-ctx, backend), runs the pinned k6 image with
`--network host` (works normally on the real-Linux `ubuntu-latest`
runner — no `host.docker.internal` workaround needed there), uploads
`tools/load-test/results/*.json` + service logs as artifacts, and fails
the job if either scenario's k6 thresholds fail.

## Measured baselines — 2026-07-09

**⚠️ These are dev-machine + mock-CTX numbers, not production capacity
numbers.** Measured via `./tools/load-test/run-local.sh both` on a
2026-era Apple Silicon MacBook (Docker Desktop, k6 run via the pinned
`grafana/k6:2.1.0` image), against the local mocked stack: in-memory
merchant cache (3-merchant seed catalog), no real CTX network latency,
no real Stellar calls, `DISABLE_RATE_LIMITING=1`, and — critically — a
laptop's CPU/RAM rather than the 512MB/1-shared-cpu Fly VM
(`apps/backend/fly.toml`) that actually serves production. They exist
to (a) prove the harness works end-to-end and (b) give a _floor_
reference for regression comparison between local runs. They say
nothing about the real breaking point. See below.

Both scenarios below are from the same `./tools/load-test/run-local.sh
both` invocation (2026-07-09), run back to back against a freshly
migrated+truncated `loop_test` database.

### `browse.js` (100 VUs peak, ~36k requests over 4 minutes)

| Metric                          | Result                 | SLO / threshold |
| ------------------------------- | ---------------------- | --------------- |
| `merchants_all` p95             | **7.06 ms**            | ≤ 200 ms        |
| `merchants_by_slug` p95         | **5.36 ms**            | ≤ 200 ms        |
| Overall `http_req_duration` p95 | 8.65 ms                | —               |
| `http_req_failed` rate          | 0.00 %                 | < 1 %           |
| Throughput                      | ~149.8 req/s           | —               |
| Checks                          | 48,044 / 48,044 passed | —               |

### `auth-order.js` (25 VUs peak, full auth→order→poll journey)

| Metric                               | Result                           | SLO / threshold |
| ------------------------------------ | -------------------------------- | --------------- |
| `order_create` p95                   | **6.28 ms**                      | ≤ 1500 ms       |
| Overall `http_req_duration` p95      | 11.39 ms                         | —               |
| `http_req_failed` rate               | 0.00 %                           | < 1 %           |
| Throughput                           | ~19.2 req/s (4,615 reqs over 4m) | —               |
| Full iterations (auth+order+2 polls) | 923                              | —               |
| Checks                               | 8,307 / 8,307 passed             | —               |

_(Full k6 text summaries for both runs are pasted in the description of
the PR that introduced this doc. `--summary-export` JSON output lands
in `tools/load-test/results/*.json` — git-ignored, regenerated per run;
re-run `./tools/load-test/run-local.sh` to reproduce, and expect
numbers in the same single-digit-to-low-double-digit millisecond range,
since both runs hit an in-memory cache / in-memory mock with no real
network hop.)_

Both runs passed every threshold with wide margin — expected, given the
in-memory/no-network conditions above. The headroom itself is the
useful signal here: it confirms the SLO thresholds (200ms / 1500ms) are
not so tight that the harness's own overhead would trip them, leaving
the thresholds meaningful once this same suite runs against a real
network hop (staging/prod).

## What this does NOT cover

This harness deliberately stays scoped to "does the k6 plumbing work
and what's a sane local floor" — the following are explicitly **not**
measured here, and B-1 stays checked-partial (🟢 harness done; 👤
operator half open) until they are:

- **Real CTX upstream latency.** mock-ctx responds in microseconds;
  `spend.ctx.com` round-trips will dominate real order-create/auth
  latency.
- **Real Stellar submission latency.** No `POST /api/orders/loop`
  payment-watcher / procurement-worker path is exercised — SEP-7
  payment confirmation and Horizon round-trips aren't in this harness
  yet (T2-lens follow-up: extend `auth-order.js` or add a
  `loop-order.js` scenario once the loop-native path is the default).
- **The production VM.** `apps/backend/fly.toml` provisions
  512MB/1-shared-cpu with `soft_limit=200` / `hard_limit=250` HTTP
  concurrency; this harness has never run against that VM or anything
  its size. The Phase-1 capacity ceilings in `docs/slo.md`
  ("Capacity, headroom, and spike plan — A2-1919") are still estimates,
  not measurements.
- **Multi-machine fleet behaviour.** `RATE_LIMIT_MACHINE_COUNT_ESTIMATE`
  and the in-memory per-process rate limiter (readiness-backlog S4-4)
  are untouched by this harness — see the next point.
- **Rate-limiter behaviour under load.** `run-local.sh` and the CI
  workflow both set `DISABLE_RATE_LIMITING=1` (matching
  `playwright.mocked.config.ts`) so ramping VUs don't trip the 5/min
  `request-otp` or 10/min `order-create` per-IP limits and produce a
  wall of expected 429s that would swamp the `errors` threshold. A
  rate-limiter-aware pass (deliberately keeping limits ON, at a VU
  count tuned to characterize 429 behavior rather than avoid it) is
  future work.
- **Autoscale behaviour.** Fly's `auto_start_machines`/scale-out
  behavior under sustained load is unexercised.

### Follow-up (👤 operator, tracked separately)

The real breaking-point measurement — pointing this harness (or a
variant with `DISABLE_RATE_LIMITING` unset and real
`GIFT_CARD_API_BASE_URL`) at a staging deployment or a scratch Fly app
sized like production — needs an operator to provision that
environment. That half of B-1 stays open; see
`docs/readiness-backlog-2026-07-03.md` B-1 and
`docs/go-live-plan.md` §T1-BS.

## Cross-reference

- `docs/slo.md` — the latency/error-budget targets these thresholds are
  derived from, and the existing "Capacity, headroom, and spike plan"
  section this harness starts to give ground truth for.
- `docs/readiness-backlog-2026-07-03.md` B-1 / `docs/go-live-plan.md`
  §T1-BS B-1 — the tracker items this doc closes the harness half of.
- `playwright.mocked.config.ts` / `tests/e2e-mocked/` — the mocked
  stack this harness reuses (mock-ctx fixture, `global-setup.ts`
  migration step, backend boot env).
- `.github/workflows/ci.yml` — the `trivy`/`gitleaks` pinned-Docker-image
  convention this harness's k6 image pin follows.
