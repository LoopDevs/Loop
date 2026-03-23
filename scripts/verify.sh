#\!/usr/bin/env bash
set -euo pipefail
echo "=== Typecheck ===" && npm run typecheck
echo "=== Lint ===" && npx eslint .
echo "=== Test ===" && npm test
echo "=== Docs ===" && ./scripts/lint-docs.sh
echo ""
echo "ALL CHECKS PASSED"
