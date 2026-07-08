#!/usr/bin/env bash
# Run every local quality check before pushing. CI runs these jobs in
# parallel; this is the strictly-sequential local equivalent.
#
# A2-1401: parity with the CI Quality + Security audit jobs. `build`
# is intentionally NOT run here — it's slow, the CI build job is
# what gates merges, and pushing without a local build is the common
# (and acceptable) iteration shape. `e2e` is also not local — it
# needs a running stack and is gated behind `npm run test:e2e`
# explicitly.
set -euo pipefail
echo "=== Typecheck ===" && npm run typecheck
echo "=== Lint ==="      && npm run lint
echo "=== Format ==="    && npm run format:check
echo "=== Docs ==="      && ./scripts/lint-docs.sh
echo "=== Type parity ===" && node scripts/check-shared-type-parity.mjs
echo "=== OpenAPI parity ===" && node ./scripts/check-openapi-parity.mjs
echo "=== Dead flags ===" && node ./scripts/check-dead-flags.mjs
echo "=== Tool self-tests ===" && npm run test:tools
echo "=== Env perms ===" && ./scripts/check-env-perms.sh
echo "=== Test ==="      && npm test
echo "=== Audit ==="     && npm run audit
echo ""
echo "ALL CHECKS PASSED"
