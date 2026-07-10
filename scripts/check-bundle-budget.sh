#!/usr/bin/env bash
#
# check-bundle-budget.sh — enforce a size ceiling on the web bundle.
#
# Closes A2-1711. The existing CI build reports bundle sizes to
# `$GITHUB_STEP_SUMMARY` but never fails on growth. One poorly-chosen
# dependency can balloon the mobile / web bundle on a cold install
# (every user pays the cost) without anyone noticing until Phase-2
# performance work. This script pins a ceiling and fails the build
# when the Web SSR client bundle crosses it.
#
# Budgets are deliberately lenient — they track current size with
# headroom, not a target. When we actually reduce bundle size the
# budget tightens in the same PR.
#
# Usage:
#   ./scripts/check-bundle-budget.sh          # uses defaults below
#
# Overrides via env vars:
#   MAX_SSR_KB=2500   — max bytes (KB) of apps/web/build/client/
#
# Exit codes:
#   0 — within budget
#   1 — over budget (details printed)
#   2 — build directory missing (run `npm run build -w @loop/web` first)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="${ROOT}/apps/web/build/client"

# Current (2026-04-24) SSR client is ~1.1 MB. 2500 KB leaves headroom
# for next 6 months of feature work. Revisit + tighten in Phase 2.
# 2026-06-11 ratchet note (comprehensive-audit P4): the documented 2500 KB
# budget was breached long before this gate was first enforced — actual
# at enforcement time was 3156 KB (largest chunks: 540 KB esm vendor,
# 180 KB entry.client, 148 KB leaflet). Ceiling reset to reality + small
# headroom so the gate prevents NEW regressions; slimming back toward
# 2500 is tracked as audit follow-up work. Tighten this number whenever
# the bundle shrinks — never loosen it without a PR-body justification.
#
# 2026-07-10 i18n-extraction bump (B-6 tranche 2, ADR 043): ADR 043 flagged
# that the first extraction tranche used 56 of the prior 60 KB headroom
# (3296/3300) and that "the next tranche that adds meaningful catalog JSON
# ... is likely to need MAX_SSR_KB raised" — this is that tranche. Adding
# settings/orders/giftCard namespace catalogs pushed the SSR client to
# 3320 KB. This is expected, documented i18n-catalog growth (per-namespace
# JSON bundled at build time, ADR 043's synchronous-init design), not a
# code regression — raised with headroom for the remaining un-extracted
# surfaces (MobileHome, brand.$slug, remaining onboarding screens) still
# tracked as follow-up B-6 tranches.
MAX_SSR_KB="${MAX_SSR_KB:-3400}"

# Per-chunk ceiling — no single vendor chunk should exceed this.
# Catches the "accidentally shipped moment + date-fns + leaflet in
# one chunk" class of regression. Current largest chunk is ~420 KB.
MAX_CHUNK_KB="${MAX_CHUNK_KB:-800}"

if [ ! -d "${BUILD_DIR}" ]; then
  echo "FAIL: build output not found at ${BUILD_DIR}"
  echo "Run \`npm run build -w @loop/web\` first."
  exit 2
fi

# Total client dir size — `du -sk` reports in 1-KB blocks.
TOTAL_KB=$(du -sk "${BUILD_DIR}" | awk '{print $1}')

echo "Web SSR client total: ${TOTAL_KB} KB (budget: ${MAX_SSR_KB} KB)"

FAILED=0
if [ "${TOTAL_KB}" -gt "${MAX_SSR_KB}" ]; then
  OVER=$((TOTAL_KB - MAX_SSR_KB))
  echo "FAIL: web SSR client is ${OVER} KB over budget (${TOTAL_KB} > ${MAX_SSR_KB})."
  FAILED=1
fi

# Per-chunk check — iterate every .js asset; flag any over MAX_CHUNK_KB.
while IFS= read -r f; do
  SIZE_KB=$(du -sk "$f" | awk '{print $1}')
  NAME=$(basename "$f")
  if [ "${SIZE_KB}" -gt "${MAX_CHUNK_KB}" ]; then
    echo "FAIL: chunk ${NAME} is ${SIZE_KB} KB (budget: ${MAX_CHUNK_KB} KB)"
    FAILED=1
  fi
done < <(find "${BUILD_DIR}/assets" -name "*.js" -type f)

if [ "${FAILED}" -eq 1 ]; then
  echo ""
  echo "Bundle budget exceeded. Either:"
  echo "  1) Fix the regression — check the last few PRs for bundle-touching work."
  echo "  2) Deliberately raise the budget — edit MAX_SSR_KB / MAX_CHUNK_KB in this script"
  echo "     and note the reason in the PR body."
  exit 1
fi

echo "OK: all bundle chunks within budget."
exit 0
