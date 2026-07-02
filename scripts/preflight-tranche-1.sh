#!/usr/bin/env bash
# Tranche-1 redeploy pre-flight check.
#
# Diffs `flyctl secrets list -a <app>` against the required Tranche-1
# secret set documented in `docs/tranche-1-launch.md` §"Operator env:
# Tranche 1 set". Reports what's present vs missing so the operator
# doesn't run `flyctl deploy` and silently launch with half-configured
# env (which would manifest as Loop-native auth disabled, payment
# watcher off, no email OTP, etc — all hard to spot in logs).
#
# Exit codes:
#   0  — all required secrets present (deploy is safe)
#   1  — at least one required secret is missing
#   2  — flyctl unavailable / app not found / auth issue
#
# Usage:
#   ./scripts/preflight-tranche-1.sh                   # default app: loopfinance-api
#   ./scripts/preflight-tranche-1.sh loop-api-staging  # staging override
#
# This script never prints secret VALUES — only key names. Safe to run
# in CI and post output to chat.

set -euo pipefail

APP="${1:-loopfinance-api}"

if ! command -v flyctl >/dev/null 2>&1; then
  echo "ERROR: flyctl not on PATH. Install via https://fly.io/docs/flyctl/install/" >&2
  exit 2
fi

# Required for any Tranche-1 deploy. Source: docs/tranche-1-launch.md
# §"Operator env: Tranche 1 set". Keep in sync with that section if you
# add/remove a hard requirement.
REQUIRED=(
  # Storage
  DATABASE_URL
  # Loop-native auth — required because LOOP_AUTH_NATIVE_ENABLED=true
  LOOP_JWT_SIGNING_KEY
  # Loop-native orders — Loop is merchant of record (ADR 010)
  LOOP_STELLAR_DEPOSIT_ADDRESS
  LOOP_STELLAR_OPERATOR_SECRET
  LOOP_STELLAR_USDC_ISSUER
  # Email OTP — required because LOOP_AUTH_NATIVE_ENABLED=true
  RESEND_API_KEY
  # Probe gating — production policy is 404 unless these are set
  METRICS_BEARER_TOKEN
  OPENAPI_BEARER_TOKEN
  # ADR 028 / hardening B3 (2026-07 plan): production boot now FAILS
  # without the step-up key (env.ts cross-field guard) — a keyless
  # deploy would pass preflight and then crash-loop at boot. Promoted
  # from RECOMMENDED when the boot guard landed. Generate with
  # `openssl rand -base64 48`. The deliberate opt-out is setting
  # DISABLE_ADMIN_STEP_UP_ENFORCEMENT=1 in fly.toml [env] (staging
  # only), in which case remove this from REQUIRED for that app.
  LOOP_ADMIN_STEP_UP_SIGNING_KEY
)

# Optional but strongly recommended — boot doesn't fail without these,
# but the deployment is degraded (lost ops visibility, or admin
# surfaces that fail closed). Reported separately so the operator sees
# the gap without it being a hard blocker.
RECOMMENDED=(
  SENTRY_DSN
  DISCORD_WEBHOOK_ORDERS
  DISCORD_WEBHOOK_MONITORING
  DISCORD_WEBHOOK_ADMIN_AUDIT
  DISCORD_WEBHOOK_DEPLOYMENTS
)

# Non-secret env vars that ride in fly.toml [env] — checked separately
# because `flyctl secrets list` doesn't surface them. The Tranche-1
# runbook expects these set as Fly secrets OR baked into [env]; we
# accept either. The script also reads `apps/backend/fly.toml` and
# resolves the value-side (Fly secrets only expose names) so a few of
# these can be VALUE-checked too — see VALUE_CHECKS below.
TOML_OR_SECRETS=(
  LOOP_PHASE_1_ONLY
  LOOP_AUTH_NATIVE_ENABLED
  LOOP_WORKERS_ENABLED
  EMAIL_PROVIDER
  EMAIL_FROM_ADDRESS
  EMAIL_FROM_NAME
  LOOP_STELLAR_USDC_FLOOR_STROOPS
  LOOP_ENV
)

# Vars where we know the canonical Tranche-1 VALUE and want to flag
# drift, not just presence. KEY=VALUE pairs. The local boot test on
# 2026-05-06 surfaced the `EMAIL_PROVIDER=resend` gate (boot refuses
# `console` in production); these pairs encode that finding so the
# preflight catches it before deploy instead of after.
declare -a VALUE_CHECKS=(
  "EMAIL_PROVIDER=resend"
  "LOOP_PHASE_1_ONLY=true"
  "LOOP_AUTH_NATIVE_ENABLED=true"
  "LOOP_WORKERS_ENABLED=true"
)

# Path to the fly.toml the deploy will use. Hardcoded for the
# Tranche-1 launch surface; flyctl deploy itself takes the same
# `--config` path.
FLY_TOML="apps/backend/fly.toml"

echo "Pre-flight: checking $APP for Tranche-1 secret coverage…"
echo

# `flyctl secrets list` outputs a table; we just want the NAME column.
# Format:
#   NAME                       │ DIGEST           │ STATUS
#   DISCORD_WEBHOOK_MONITORING │ 381005b6ea2fe1bd │ Deployed
# Awk trims to the first column.
SECRETS_RAW="$(flyctl secrets list -a "$APP" 2>&1)" || {
  echo "ERROR: flyctl secrets list -a $APP failed:" >&2
  echo "$SECRETS_RAW" >&2
  exit 2
}

# Extract just the name column (first non-header non-separator line).
PRESENT="$(printf '%s\n' "$SECRETS_RAW" \
  | awk -F'│' 'NR>1 && $1 !~ /^[[:space:]]*$/ {gsub(/[[:space:]]/,"",$1); print $1}' \
  | sort -u)"

contains() {
  local needle="$1"
  printf '%s\n' "$PRESENT" | grep -qx -- "$needle"
}

# Read a single key's value from the fly.toml [env] block. Outputs the
# raw string (without quotes) on stdout, or empty string if the key
# isn't set. Naive parser sufficient for our [env] block which is
# strictly KEY = "VALUE" lines — no nested tables, no multi-line
# strings. Anchors on `^[env]$` and stops at the next `^[` line.
toml_env_value() {
  local key="$1"
  if [ ! -f "$FLY_TOML" ]; then
    return 0
  fi
  awk -v k="$key" '
    /^\[env\][[:space:]]*$/ { in_env = 1; next }
    in_env && /^\[/        { in_env = 0 }
    in_env {
      # Match `  KEY = "VALUE"` or `KEY = "VALUE"` (any whitespace).
      if (match($0, "^[[:space:]]*" k "[[:space:]]*=[[:space:]]*\"([^\"]*)\"")) {
        print substr($0, RSTART, RLENGTH)
        exit
      }
    }
  ' "$FLY_TOML" \
    | sed -E 's/^[^"]*"([^"]*)"$/\1/'
}

# Returns 0 if `key` is set as a Fly secret OR in fly.toml [env]
# (regardless of value). Tells the caller "this key is configured
# somewhere"; the value-side check is a separate step.
key_set_anywhere() {
  local key="$1"
  if contains "$key"; then return 0; fi
  if [ -n "$(toml_env_value "$key")" ]; then return 0; fi
  return 1
}

MISSING_REQUIRED=()
PRESENT_REQUIRED=()
for key in "${REQUIRED[@]}"; do
  if contains "$key"; then
    PRESENT_REQUIRED+=("$key")
  else
    MISSING_REQUIRED+=("$key")
  fi
done

MISSING_RECOMMENDED=()
PRESENT_RECOMMENDED=()
for key in "${RECOMMENDED[@]}"; do
  if contains "$key"; then
    PRESENT_RECOMMENDED+=("$key")
  else
    MISSING_RECOMMENDED+=("$key")
  fi
done

MISSING_TOML=()
PRESENT_TOML=()      # in Fly secrets
PRESENT_TOML_FILE=() # in fly.toml [env] only
for key in "${TOML_OR_SECRETS[@]}"; do
  if contains "$key"; then
    PRESENT_TOML+=("$key")
  elif [ -n "$(toml_env_value "$key")" ]; then
    PRESENT_TOML_FILE+=("$key=$(toml_env_value "$key")")
  else
    MISSING_TOML+=("$key")
  fi
done

# Value-side drift check. For each `KEY=EXPECTED` in VALUE_CHECKS,
# resolve the effective value (fly.toml [env] takes precedence over
# `[secret-set?]` since we can't read secret values; if the key is a
# Fly secret only, we report "value-uncheckable"). Drift = effective
# value differs from expected.
VALUE_OK=()
VALUE_DRIFT=()
VALUE_UNCHECKABLE=()
for pair in "${VALUE_CHECKS[@]}"; do
  key="${pair%%=*}"
  expected="${pair#*=}"
  toml_val="$(toml_env_value "$key")"
  if [ -n "$toml_val" ]; then
    if [ "$toml_val" = "$expected" ]; then
      VALUE_OK+=("$key=$toml_val")
    else
      VALUE_DRIFT+=("$key=$toml_val (expected $expected)")
    fi
  elif contains "$key"; then
    VALUE_UNCHECKABLE+=("$key (in Fly secrets — flyctl can't read values; verify manually)")
  fi
  # Absent entirely is already reported by the TOML_OR_SECRETS loop.
done

echo "── REQUIRED secrets (boot-time hard requirements) ─────────────────"
if [ ${#PRESENT_REQUIRED[@]} -gt 0 ]; then
  printf '  ✓ %s\n' "${PRESENT_REQUIRED[@]}"
fi
if [ ${#MISSING_REQUIRED[@]} -gt 0 ]; then
  printf '  ✗ %s (MISSING)\n' "${MISSING_REQUIRED[@]}"
fi
echo

echo "── RECOMMENDED secrets (ops visibility) ───────────────────────────"
if [ ${#PRESENT_RECOMMENDED[@]} -gt 0 ]; then
  printf '  ✓ %s\n' "${PRESENT_RECOMMENDED[@]}"
fi
if [ ${#MISSING_RECOMMENDED[@]} -gt 0 ]; then
  printf '  · %s (recommended, not blocking)\n' "${MISSING_RECOMMENDED[@]}"
fi
echo

echo "── TOML-or-secrets (Fly secrets OR fly.toml [env]) ────────────────"
if [ ${#PRESENT_TOML[@]} -gt 0 ]; then
  printf '  ✓ %s (in Fly secrets)\n' "${PRESENT_TOML[@]}"
fi
if [ ${#PRESENT_TOML_FILE[@]} -gt 0 ]; then
  printf '  ✓ %s (in fly.toml [env])\n' "${PRESENT_TOML_FILE[@]}"
fi
if [ ${#MISSING_TOML[@]} -gt 0 ]; then
  printf '  ? %s (absent from Fly secrets AND fly.toml [env])\n' "${MISSING_TOML[@]}"
fi
echo

echo "── VALUE checks (drift between fly.toml and Tranche-1 expected) ───"
if [ ${#VALUE_OK[@]} -gt 0 ]; then
  printf '  ✓ %s\n' "${VALUE_OK[@]}"
fi
if [ ${#VALUE_UNCHECKABLE[@]} -gt 0 ]; then
  printf '  ? %s\n' "${VALUE_UNCHECKABLE[@]}"
fi
if [ ${#VALUE_DRIFT[@]} -gt 0 ]; then
  printf '  ✗ %s\n' "${VALUE_DRIFT[@]}"
fi
echo

if [ ${#MISSING_REQUIRED[@]} -gt 0 ]; then
  echo "FAIL: ${#MISSING_REQUIRED[@]} required secret(s) missing. Set them via:"
  echo "  flyctl secrets set -a $APP <KEY1>=… <KEY2>=…"
  echo "Then re-run this script before deploying."
  exit 1
fi

if [ ${#VALUE_DRIFT[@]} -gt 0 ]; then
  echo "FAIL: ${#VALUE_DRIFT[@]} fly.toml value(s) drift from Tranche-1 expected:"
  printf '  - %s\n' "${VALUE_DRIFT[@]}"
  echo "Update apps/backend/fly.toml [env] (or override via secret) and re-run."
  exit 1
fi

echo "PASS: all ${#REQUIRED[@]} required secrets present and ${#VALUE_OK[@]}/${#VALUE_CHECKS[@]} fly.toml values match expected. Safe to:"
echo "  flyctl deploy -a $APP --config apps/backend/fly.toml"
exit 0
