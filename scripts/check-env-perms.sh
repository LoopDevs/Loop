#!/usr/bin/env bash
# A4-116: warn on permissive mode bits on git-ignored .env files
# that local users/processes/malware on the dev machine could
# otherwise read. The files contain secret-bearing values
# (GIFT_CARD_API_*, DISCORD_WEBHOOK_*, VITE_SENTRY_DSN, etc).
#
# Exit 0 with no output if everything is mode 600 (or stricter).
# Print a warning + the offending mode for any path that has any
# bits set in `g` or `o`. Always exits 0 — this is a hygiene
# nudge, not a hard gate (developer machines vary, and the secret
# rotation cost is low).
set -euo pipefail

paths=(
  apps/backend/.env
  apps/web/.env.local
)

found_lax=0

for p in "${paths[@]}"; do
  if [ -f "$p" ]; then
    # Portable mode read: stat differs between BSD (macOS) and GNU.
    if mode="$(stat -f '%Lp' "$p" 2>/dev/null)"; then
      :
    else
      mode="$(stat -c '%a' "$p")"
    fi
    # Strip leading zeros so 600 / 0600 compare equal.
    mode="${mode#0}"
    if [ "${mode}" != "600" ]; then
      if [ $found_lax -eq 0 ]; then
        echo "WARN: env files contain secrets and should be mode 600 — found:"
        found_lax=1
      fi
      printf '  %s — mode %s (expected 600)\n' "$p" "$mode"
    fi
  fi
done

if [ $found_lax -ne 0 ]; then
  echo "Run: chmod 600 ${paths[*]}"
fi

exit 0
