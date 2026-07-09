#!/usr/bin/env bash
# tools/load-test/run-local.sh
#
# Boots the exact same self-contained stack the mocked-e2e Playwright suite
# uses — mock-ctx on :9091, backend (tsx, NODE_ENV=test) on :8081, real
# postgres on :5433 via docker-compose (see playwright.mocked.config.ts) —
# and runs the k6 scenarios in tools/load-test/ against it. This is the
# LOCAL dev-machine half of docs/go-live-plan.md §T1-BS B-1 / the
# readiness-backlog B-1 item; see docs/load-testing.md for what the
# resulting numbers do and don't mean (dev-machine + mock CTX, not a
# production capacity number).
#
# Usage:
#   ./tools/load-test/run-local.sh [browse|auth-order|both]   # default: both
#
# Env overrides:
#   BASE_URL   — force the URL k6 hits (skips the darwin/docker networking
#                resolution below).
#   K6_BIN     — 'docker' (default, uses the pinned-by-digest k6 image, same
#                pattern as the trivy/gitleaks jobs in .github/workflows/
#                ci.yml) or 'k6' (uses a PATH-installed k6 binary —
#                `brew install k6`). If docker-run-k6 is flaky on your
#                machine, K6_BIN=k6 is the documented fallback (see
#                docs/load-testing.md).
#   VUS_SCALE  — multiplies every scenario's staged VU targets (default 1).
#                Forwarded to k6 as `-e VUS_SCALE=...`; see
#                config.js::scaleStages.
#
# macOS/Docker-Desktop networking note: `docker run --network host` does
# NOT reach the host's localhost ports on Docker Desktop for Mac (the
# daemon runs containers inside a Linux VM with its own network
# namespace — unlike a real Linux docker host, where --network host puts
# the container directly on the host's network stack). We therefore only
# pass --network host on Linux (this matches the ubuntu-latest CI runner
# used by .github/workflows/load-test.yml) and instead point BASE_URL at
# `host.docker.internal` on darwin, which Docker Desktop resolves to the
# host for us. Verified locally on Docker Desktop 28.3 / macOS: `--network
# host` is silently accepted but the container cannot reach 127.0.0.1 on
# the host, while `host.docker.internal` works.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"
mkdir -p "$RESULTS_DIR"
# The grafana/k6 image runs `--summary-export` as a non-root, non-host uid
# (uid 12345 — confirmed via `docker run grafana/k6:2.1.0 ... id`), so a
# bind-mounted results/ dir created with the default host-user umask (755)
# is not writable from inside the container. world-writable is fine here:
# this is a throwaway, git-ignored, local/CI-only results directory, never
# anything sensitive. Confirmed necessary on a real Linux Docker host
# (ubuntu-latest CI) — Docker Desktop's macOS bind-mount bridge is looser
# about container-uid permission checks and doesn't show this without it.
chmod 777 "$RESULTS_DIR"

SCENARIO="${1:-both}"
case "$SCENARIO" in
  browse | auth-order | both) ;;
  *)
    echo "usage: $0 [browse|auth-order|both]" >&2
    exit 64
    ;;
esac

K6_BIN="${K6_BIN:-docker}"
# Pinned by digest, same convention as aquasec/trivy + zricethezav/gitleaks
# in .github/workflows/ci.yml (ADR 029's reproducibility rationale, applied
# to a Docker image rather than a CLI binary). This is the multi-arch
# manifest-index digest (`docker buildx imagetools inspect grafana/k6:2.1.0`),
# so it resolves correctly on both arm64 dev laptops and the amd64 CI
# runner. Bump deliberately; k6 is a Go binary with no npm lockfile to pin
# it, which is why this lives here instead (go-live-plan B-1: "k6 is a
# binary, not an npm dep, so no ADR needed, but document how to run").
K6_IMAGE='grafana/k6:2.1.0@sha256:65c920dc067d5e2e00befbf982af6ad6ad0117034e8b1c65817c7975c52d4669'

MOCK_CTX_PORT=9091
BACKEND_PORT=8081
DB_PORT=5433
DATABASE_URL="${DATABASE_URL:-postgres://loop:loop@localhost:${DB_PORT}/loop_test}"

BACKEND_URL="http://localhost:${BACKEND_PORT}"
MOCK_CTX_URL="http://localhost:${MOCK_CTX_PORT}"

if [ -n "${BASE_URL:-}" ]; then
  RESOLVED_BASE_URL="$BASE_URL"
elif [ "$K6_BIN" = "docker" ] && [ "$(uname -s)" = "Darwin" ]; then
  RESOLVED_BASE_URL="http://host.docker.internal:${BACKEND_PORT}"
else
  RESOLVED_BASE_URL="$BACKEND_URL"
fi

STARTED_MOCK_CTX_PID=""
STARTED_BACKEND_PID=""

cleanup() {
  # Only stop what THIS script started — an already-running dev backend
  # (e.g. from `npm run dev`) or mock-ctx is left alone. The docker-compose
  # postgres is also left running deliberately: it's the shared local dev
  # database (docker-compose.yml), not something this script owns
  # exclusively.
  if [ -n "$STARTED_BACKEND_PID" ]; then
    echo "[run-local] stopping backend (pid $STARTED_BACKEND_PID)"
    kill "$STARTED_BACKEND_PID" 2>/dev/null || true
    wait "$STARTED_BACKEND_PID" 2>/dev/null || true
  fi
  if [ -n "$STARTED_MOCK_CTX_PID" ]; then
    echo "[run-local] stopping mock-ctx (pid $STARTED_MOCK_CTX_PID)"
    kill "$STARTED_MOCK_CTX_PID" 2>/dev/null || true
    wait "$STARTED_MOCK_CTX_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

wait_for() {
  # wait_for <url> <label> <timeout_seconds>
  local url="$1" label="$2" timeout="${3:-60}" waited=0
  until curl -fsS "$url" >/dev/null 2>&1; do
    waited=$((waited + 1))
    if [ "$waited" -ge "$timeout" ]; then
      echo "[run-local] timed out waiting for $label at $url" >&2
      return 1
    fi
    sleep 1
  done
  echo "[run-local] $label is up ($url)"
}

cd "$ROOT_DIR"

echo "[run-local] starting postgres (docker compose up -d db)..."
docker compose up -d db

echo "[run-local] waiting for postgres..."
pg_waited=0
until docker compose exec -T db pg_isready -U loop -d loop_test >/dev/null 2>&1; do
  pg_waited=$((pg_waited + 1))
  if [ "$pg_waited" -ge 60 ]; then
    echo "[run-local] timed out waiting for postgres" >&2
    exit 1
  fi
  sleep 1
done
echo "[run-local] postgres is up"

echo "[run-local] running migrations (tests/e2e-mocked/global-setup.ts, via tools/load-test/migrate.mjs)..."
DATABASE_URL="$DATABASE_URL" npx tsx tools/load-test/migrate.mjs

if curl -fsS "$MOCK_CTX_URL/status" >/dev/null 2>&1; then
  echo "[run-local] reusing already-running mock-ctx at $MOCK_CTX_URL"
else
  echo "[run-local] starting mock-ctx..."
  PORT="$MOCK_CTX_PORT" node tests/e2e-mocked/fixtures/mock-ctx.mjs >"$RESULTS_DIR/mock-ctx.log" 2>&1 &
  STARTED_MOCK_CTX_PID=$!
  wait_for "$MOCK_CTX_URL/status" "mock-ctx" 20
fi

if curl -fsS "$BACKEND_URL/health" >/dev/null 2>&1; then
  echo "[run-local] reusing already-running backend at $BACKEND_URL"
else
  echo "[run-local] starting backend..."
  # Mirrors playwright.mocked.config.ts's webServer entry verbatim: no
  # --env-file (so a real apps/backend/.env can't stomp these test values),
  # LOOP_AUTH_NATIVE_ENABLED left unset (legacy CTX-proxy auth path),
  # DISABLE_RATE_LIMITING=1 so the load-test VUs don't immediately trip the
  # 5/min request-otp or 10/min order-create per-IP limits.
  env \
    PORT="$BACKEND_PORT" \
    NODE_ENV=test \
    LOG_LEVEL=warn \
    GIFT_CARD_API_BASE_URL="$MOCK_CTX_URL" \
    REFRESH_INTERVAL_HOURS=6 \
    LOCATION_REFRESH_INTERVAL_HOURS=24 \
    DATABASE_URL="$DATABASE_URL" \
    DISABLE_RATE_LIMITING=1 \
    npm exec -w @loop/backend -- tsx src/index.ts >"$RESULTS_DIR/backend.log" 2>&1 &
  STARTED_BACKEND_PID=$!
  wait_for "$BACKEND_URL/health" "backend" 60
fi

# Best-effort reset of mock-ctx state + backend per-IP rate-limit state —
# mirrors tests/e2e-mocked/purchase-flow.test.ts::resetMock(). Harmless if
# either service was already running with leftover state from a previous
# manual session.
curl -fsS -X POST "$MOCK_CTX_URL/_test/reset" >/dev/null 2>&1 || true
curl -fsS -X POST "$BACKEND_URL/__test__/reset" >/dev/null 2>&1 || true

run_k6() {
  local scenario="$1"
  local summary="$RESULTS_DIR/${scenario}-summary.json"
  echo "[run-local] running k6 scenario '$scenario' against BASE_URL=$RESOLVED_BASE_URL (k6 via $K6_BIN)"

  if [ "$K6_BIN" = "docker" ]; then
    # NOTE: deliberately two near-identical `docker run` invocations rather
    # than building a `--network host` flag into an array — macOS ships
    # bash 3.2 (GPLv3 licensing), which mishandles `"${arr[@]}"` on an
    # empty array under `set -u` ("unbound variable"). Confirmed on this
    # harness: an array-based version failed on macOS/bash 3.2 exactly
    # that way.
    if [ "$(uname -s)" = "Darwin" ]; then
      docker run --rm \
        -v "$SCRIPT_DIR":/scripts \
        -e BASE_URL="$RESOLVED_BASE_URL" \
        -e VUS_SCALE="${VUS_SCALE:-1}" \
        "$K6_IMAGE" \
        run --summary-export="/scripts/results/${scenario}-summary.json" "/scripts/${scenario}.js"
    else
      docker run --rm --network host \
        -v "$SCRIPT_DIR":/scripts \
        -e BASE_URL="$RESOLVED_BASE_URL" \
        -e VUS_SCALE="${VUS_SCALE:-1}" \
        "$K6_IMAGE" \
        run --summary-export="/scripts/results/${scenario}-summary.json" "/scripts/${scenario}.js"
    fi
  else
    BASE_URL="$RESOLVED_BASE_URL" VUS_SCALE="${VUS_SCALE:-1}" \
      k6 run --summary-export="$summary" "$SCRIPT_DIR/${scenario}.js"
  fi
}

case "$SCENARIO" in
  browse) run_k6 browse ;;
  auth-order) run_k6 auth-order ;;
  both)
    run_k6 browse
    run_k6 auth-order
    ;;
esac

echo "[run-local] done. Summaries in $RESULTS_DIR/"
