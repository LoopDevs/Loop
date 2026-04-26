#!/usr/bin/env bash
#
# check-admin-bundle-split.sh — assert admin routes ship as their own
# code-split chunks, never in the entry / root chunk that every visitor
# downloads.
#
# Closes A2-1115. The audit flagged that admin bundle splitting was
# unverified — RR v7 splits per route by default, but a regression
# (e.g. importing `AdminNav` directly from `root.tsx`, or eagerly
# loading an admin module from a non-admin route) would silently ship
# admin payloads to every signed-out visitor. This script makes that
# regression a CI failure.
#
# Verification strategy (per audit notes):
#   1. The build output contains a per-admin-route chunk for every
#      `apps/web/app/routes/admin*.tsx` file.
#   2. `entry.client*.js` and `root*.js` contain zero references to
#      admin route names — those references can only come from a
#      lazy-import boundary, which means the admin code lives in its
#      own chunk and only loads when the user navigates to an admin
#      route (which `<RequireAdmin>` already gates).
#
# Usage:
#   ./scripts/check-admin-bundle-split.sh
#
# Run after `npm run build -w @loop/web`. Exits 0 when split is
# correct, 1 on regression, 2 if the build output is missing.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="${ROOT}/apps/web/build/client/assets"
ROUTES_DIR="${ROOT}/apps/web/app/routes"

if [ ! -d "${BUILD_DIR}" ]; then
  echo "FAIL: build output not found at ${BUILD_DIR}"
  echo "Run \`npm run build -w @loop/web\` first."
  exit 2
fi

# 1. Count the number of admin route source files (should match the
#    number of admin chunks emitted, modulo bundling of tiny chunks).
ADMIN_SRC_COUNT=$(find "${ROUTES_DIR}" -maxdepth 1 -name 'admin*.tsx' -type f | wc -l | tr -d ' ')
ADMIN_CHUNK_COUNT=$(find "${BUILD_DIR}" -maxdepth 1 -name 'admin*.js' -type f | wc -l | tr -d ' ')

echo "Admin route source files: ${ADMIN_SRC_COUNT}"
echo "Admin chunks in build:    ${ADMIN_CHUNK_COUNT}"

FAILED=0

# Tolerate small bundling fluctuations — require at least 80% of
# routes to have their own chunk so a single regression that pulls
# everything back into one bundle still trips the alarm.
MIN_CHUNKS=$(( (ADMIN_SRC_COUNT * 8) / 10 ))
if [ "${ADMIN_CHUNK_COUNT}" -lt "${MIN_CHUNKS}" ]; then
  echo "FAIL: only ${ADMIN_CHUNK_COUNT} admin chunks emitted, expected at least ${MIN_CHUNKS} (80% of ${ADMIN_SRC_COUNT})."
  FAILED=1
fi

# 2. Verify entry.client + root chunks don't reference admin route
#    names. RR v7's lazy-loading produces a manifest-mediated import
#    boundary; admin route module names should appear *only* in their
#    own chunks and the route manifest, never in the eagerly-loaded
#    entry / root payload.
for prefix in entry.client root; do
  match=$(find "${BUILD_DIR}" -maxdepth 1 -name "${prefix}*.js" -type f -print0 \
    | xargs -0 grep -lE 'admin\.(_index|cashback|treasury|payouts|orders|stuck-orders|merchants|users|operators|assets|audit)' 2>/dev/null || true)
  if [ -n "${match}" ]; then
    echo "FAIL: admin route name found in eagerly-loaded chunk(s):"
    echo "${match}"
    FAILED=1
  fi
done

if [ "${FAILED}" -eq 1 ]; then
  echo ""
  echo "Admin code is leaking into the eagerly-loaded bundle."
  echo "Likely causes:"
  echo "  - A non-admin route or component imports from \`routes/admin*.tsx\` directly."
  echo "  - Vite's manualChunks override pulls admin code into entry/root."
  echo "Fix the import boundary so admin code stays behind a lazy import."
  exit 1
fi

echo "OK: admin routes are code-split out of the eagerly-loaded bundle."
exit 0
