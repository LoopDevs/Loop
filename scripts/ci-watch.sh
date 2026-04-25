#!/usr/bin/env bash
# scripts/ci-watch.sh — poll a PR's required CI checks and print
# state-change events until either 5/5 pass or any fail.
#
# Replaces the per-PR Monitor task so the agent doesn't have to ask
# the user to approve a fresh background process for every PR. The
# allowlist entry `Bash(./scripts/ci-watch.sh)` in
# `.claude/settings.local.json` lets it run without prompts.
#
# Usage: ./scripts/ci-watch.sh <pr-number>
# Exit:  0 once all 5 required checks succeed; 1 on first FAILURE /
#        CANCELLED; 2 if the PR closes or merges before reaching a
#        terminal CI state.
#
# Output: one line per state change in the format
#   [HH:MM:SSZ] pr<N>=<state> required_passing=<P> required_failing=<F>
#
# The agent watches stdout and acts on the first 5/5 line.

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: ./scripts/ci-watch.sh <pr-number>" >&2
  exit 64
fi

PR=$1
LAST=""
# Cap polling at 30 minutes so a stuck CI doesn't hang the script
# forever — the agent's wakeup safety net is already 25min.
DEADLINE=$(($(date +%s) + 1800))

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  state=$(gh pr view "$PR" --json state,statusCheckRollup 2>/dev/null | jq -r '
    (.state) as $s |
    ((.statusCheckRollup // []) | map(select(
      .name == "Quality (typecheck, lint, format, docs)"
      or .name == "Unit tests"
      or .name == "Security audit"
      or .name == "Build verification"
      or .name == "E2E tests (mocked CTX)"
    ))) as $req |
    ($req | map(select(.conclusion == "SUCCESS")) | length) as $p |
    ($req | map(select(.conclusion == "FAILURE" or .conclusion == "CANCELLED")) | length) as $f |
    "pr\($s) required_passing=\($p) required_failing=\($f)"
  ' || echo "err")

  # Pull out the parts we branch on. The state echo above already
  # carries the values we need.
  passing=$(echo "$state" | sed -E 's/.*required_passing=([0-9]+).*/\1/')
  failing=$(echo "$state" | sed -E 's/.*required_failing=([0-9]+).*/\1/')
  pr_state=$(echo "$state" | sed -E 's/^pr([A-Z]+) .*/\1/')

  if [ "$state" != "$LAST" ]; then
    printf '[%s] pr%s=%s required_passing=%s required_failing=%s\n' \
      "$(date -u +%H:%M:%SZ)" "$PR" "$pr_state" "$passing" "$failing"
    LAST=$state
  fi

  # Terminal: PR closed/merged before CI finished, or any required
  # check failed, or all 5 required checks passed.
  if [ "$pr_state" = "MERGED" ] || [ "$pr_state" = "CLOSED" ]; then
    exit 2
  fi
  if [ "$failing" -gt 0 ]; then
    exit 1
  fi
  if [ "$passing" -ge 5 ]; then
    exit 0
  fi

  sleep 30
done

# Timed out — let the caller decide what to do with that.
echo "[$(date -u +%H:%M:%SZ)] pr$PR=TIMEOUT required_passing=$passing required_failing=$failing" >&2
exit 3
