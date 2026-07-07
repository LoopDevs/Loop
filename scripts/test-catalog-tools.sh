#!/usr/bin/env bash
# Runs the --self-test on every catalog media-pipeline tool script. These aren't
# covered by vitest (tools/ isn't an npm workspace), so this guards them against
# regressions in CI. All listed here are NETWORK-FREE (deterministic prompt/parse
# + sharp); cover-text-scan is deliberately excluded because its --self-test boots
# Tesseract (downloads traineddata) — running it here would add a network
# dependency to the check. Its logic is exercised by its own --self-test locally.
set -uo pipefail
cd "$(dirname "$0")/.."
tools=(domain-tools brand-brief brand-family source-images-tavily logo-sources
  image-qc vision-qc ai-extract ai-info merchant-state build-state ctx-write)
fail=0
for t in "${tools[@]}"; do
  if node "tools/ctx-catalog/$t.mjs" --self-test >/dev/null 2>&1; then
    echo "  ✓ $t"
  else
    echo "  ✗ $t"
    fail=$((fail + 1))
  fi
done
# cover-text-scan's full --self-test boots Tesseract (network); its pure classify
# logic is covered network-free via --self-test-logic.
if node tools/ctx-catalog/cover-text-scan.mjs --self-test-logic >/dev/null 2>&1; then
  echo "  ✓ cover-text-scan (logic)"
else
  echo "  ✗ cover-text-scan (logic)"
  fail=$((fail + 1))
fi
if [ "$fail" -gt 0 ]; then
  echo "FAILED: $fail catalog tool self-test(s)"
  exit 1
fi
echo "OK: all $((${#tools[@]} + 1)) catalog tool self-tests passed"
