#!/usr/bin/env bash
# Run every quality check sequentially; CI runs the same checks as
# parallel steps.
set -euo pipefail
echo "=== Typecheck ===" && npm run typecheck
echo "=== Lint ==="      && npm run lint
echo "=== Format ==="    && npm run format:check
echo "=== Test ==="      && npm test
echo "=== Audit ==="     && npm run audit
echo ""
echo "ALL CHECKS PASSED"
