#!/usr/bin/env bash
# Run every local quality check before pushing. CI runs these jobs in
# parallel; this is the strictly-sequential local equivalent.
set -euo pipefail
echo "=== Typecheck ===" && npm run typecheck
echo "=== Lint ==="      && npm run lint
echo "=== Format ==="    && npm run format:check
echo "=== Docs ==="      && ./scripts/lint-docs.sh
echo "=== Test ==="      && npm test
echo ""
echo "ALL CHECKS PASSED"
