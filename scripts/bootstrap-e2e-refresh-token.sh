#!/usr/bin/env bash
# Bootstrap LOOP_E2E_REFRESH_TOKEN via a manual OTP flow.
#
# The e2e-real workflow (`scripts/e2e-real.mjs`) refreshes a
# Loop-native access token from a long-lived refresh token stored as
# a repo secret. There's no programmatic way to mint that first
# refresh token — Loop-native auth is OTP-only, and OTPs land in an
# inbox.
#
# This script automates everything except the inbox check:
#
#   1. POST /api/auth/request-otp  — backend emails the operator the OTP
#   2. Operator enters the 6-digit OTP from their inbox at the prompt
#   3. POST /api/auth/verify-otp   — backend returns access + refresh
#   4. Script either prints the refresh token (operator copies into
#      1Password / repo secret) OR uploads it directly via `gh secret
#      set` if --gh-secret is passed.
#
# The refresh token rotates on every /refresh-token call (CTX and
# Loop-native both do this). After this bootstrap, the GitHub
# workflow's "Rotate LOOP_E2E_REFRESH_TOKEN secret" step keeps the
# repo secret in sync — bootstrap is one-time.
#
# Usage:
#   ./scripts/bootstrap-e2e-refresh-token.sh
#     [--backend https://api.loopfinance.io]   # default localhost:8080
#     [--email reviewer@loopfinance.io]         # prompted if omitted
#     [--gh-secret]                              # upload via gh CLI
#     [--repo owner/name]                        # required with --gh-secret
#                                                # if not in a git repo
#
# Backend prerequisites:
#   LOOP_AUTH_NATIVE_ENABLED=true    (else /verify-otp returns CTX tokens
#                                     which won't work for Loop-native /api/orders/loop)
#
# This script is operator-only — run on the operator's local machine
# against a real backend. Do NOT run inside CI.

set -euo pipefail

BACKEND_URL="http://localhost:8080"
EMAIL=""
USE_GH_SECRET=0
GH_REPO=""

while [ $# -gt 0 ]; do
  case "$1" in
    --backend)   BACKEND_URL="$2"; shift 2 ;;
    --email)     EMAIL="$2"; shift 2 ;;
    --gh-secret) USE_GH_SECRET=1; shift ;;
    --repo)      GH_REPO="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,/^set -e/p' "$0" | sed 's|^# \?||;/^$/d;/^set/d'
      exit 0
      ;;
    *)
      echo "ERROR: unknown flag $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$EMAIL" ]; then
  printf 'Email address (where the OTP will be sent): '
  read -r EMAIL
fi
if [ -z "$EMAIL" ]; then
  echo "ERROR: email is required" >&2
  exit 2
fi

echo
echo "Backend: $BACKEND_URL"
echo "Email:   $EMAIL"
echo

# Step 1 — request OTP. Backend emails the operator within ~30s.
echo "→ POST $BACKEND_URL/api/auth/request-otp"
REQUEST_RES=$(curl -sS -w '\n%{http_code}' -X POST \
  -H 'Content-Type: application/json' \
  --data "$(printf '{"email":"%s","platform":"web"}' "$EMAIL")" \
  "$BACKEND_URL/api/auth/request-otp")
REQUEST_CODE=$(echo "$REQUEST_RES" | tail -n1)
REQUEST_BODY=$(echo "$REQUEST_RES" | sed '$d')

if [ "$REQUEST_CODE" != "200" ] && [ "$REQUEST_CODE" != "204" ]; then
  echo "ERROR: request-otp returned HTTP $REQUEST_CODE" >&2
  echo "$REQUEST_BODY" >&2
  exit 1
fi
echo "  OK ($REQUEST_CODE)"
echo

# Step 2 — operator enters the OTP. The backend Resend integration
# should deliver within 30s; if not, check spam, DKIM verification on
# loopfinance.io, and Resend dashboard logs.
printf 'Check your inbox at %s and enter the 6-digit OTP: ' "$EMAIL"
read -r OTP
if [ -z "$OTP" ]; then
  echo "ERROR: OTP is required" >&2
  exit 2
fi
echo

# Step 3 — verify OTP, get tokens.
echo "→ POST $BACKEND_URL/api/auth/verify-otp"
VERIFY_RES=$(curl -sS -w '\n%{http_code}' -X POST \
  -H 'Content-Type: application/json' \
  --data "$(printf '{"email":"%s","otp":"%s","platform":"web"}' "$EMAIL" "$OTP")" \
  "$BACKEND_URL/api/auth/verify-otp")
VERIFY_CODE=$(echo "$VERIFY_RES" | tail -n1)
VERIFY_BODY=$(echo "$VERIFY_RES" | sed '$d')

if [ "$VERIFY_CODE" != "200" ]; then
  echo "ERROR: verify-otp returned HTTP $VERIFY_CODE" >&2
  echo "$VERIFY_BODY" >&2
  exit 1
fi

REFRESH_TOKEN=$(printf '%s' "$VERIFY_BODY" | python3 -c '
import json, sys
data = json.load(sys.stdin)
token = data.get("refreshToken")
if not token:
    print("MISSING_REFRESH_TOKEN", file=sys.stderr)
    sys.exit(1)
print(token)
')
if [ -z "$REFRESH_TOKEN" ]; then
  echo "ERROR: refreshToken missing from verify-otp response. Backend may not have LOOP_AUTH_NATIVE_ENABLED=true." >&2
  echo "Response body:" >&2
  echo "$VERIFY_BODY" >&2
  exit 1
fi
echo "  OK — refresh token obtained (length: ${#REFRESH_TOKEN} chars)"
echo

# Step 4 — output. Either print, or upload to repo secret via gh CLI.
if [ "$USE_GH_SECRET" -eq 1 ]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "ERROR: gh CLI not on PATH but --gh-secret requested." >&2
    echo "  Install: brew install gh" >&2
    exit 1
  fi
  GH_ARGS=(secret set LOOP_E2E_REFRESH_TOKEN)
  if [ -n "$GH_REPO" ]; then
    GH_ARGS+=(--repo "$GH_REPO")
  fi
  # Pipe via stdin so the token never appears in argv / `ps`.
  printf '%s' "$REFRESH_TOKEN" | gh "${GH_ARGS[@]}"
  echo "✓ Uploaded to repo secret LOOP_E2E_REFRESH_TOKEN"
  echo
  echo "Test it: GitHub → Actions → 'E2E (real Tranche-1 purchase + wallet)' → Run workflow"
else
  echo "──────────────────────────────────────────────────────────────────────────"
  echo "REFRESH TOKEN (copy this — store as the LOOP_E2E_REFRESH_TOKEN repo secret):"
  echo
  echo "$REFRESH_TOKEN"
  echo
  echo "──────────────────────────────────────────────────────────────────────────"
  echo "To upload directly:"
  echo "  echo '$REFRESH_TOKEN' | gh secret set LOOP_E2E_REFRESH_TOKEN"
  echo
  echo "Or pass --gh-secret to this script next time."
fi
