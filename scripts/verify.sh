#!/usr/bin/env bash
# Run every quality check sequentially. Drone runs this before building
# images; GitHub CI runs the same jobs in parallel.
set -euo pipefail
echo "=== Typecheck ===" && npm run typecheck
echo "=== Lint ==="      && npm run lint
echo "=== Format ==="    && npm run format:check
echo "=== Test ==="      && npm test
echo "=== Audit ==="     && npm run audit
echo ""
echo "ALL CHECKS PASSED"
