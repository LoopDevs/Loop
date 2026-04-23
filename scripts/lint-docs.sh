#!/usr/bin/env bash
# Checks that documentation stays in sync with code.
# Runs in CI — fails the build if docs are stale.
set -euo pipefail

ERROR_FILE=$(mktemp)
echo "0" > "$ERROR_FILE"

err() {
  echo "  ERROR: $1" >&2
  count=$(cat "$ERROR_FILE")
  echo "$((count + 1))" > "$ERROR_FILE"
}

# ─── 1. Every env var in env.ts must be in .env.example ─────────────────────

echo "Checking env vars..."
grep -E '^\s+[A-Z_]+:' apps/backend/src/env.ts | sed 's/[[:space:]]*//' | cut -d: -f1 | while read -r var; do
  if ! grep -q "^${var}=\|^# *${var}" apps/backend/.env.example 2>/dev/null; then
    err "Env var '$var' is in env.ts but missing from .env.example"
  fi
done

# ─── 2. Every API route in app.ts should be in architecture.md ──────────────

echo "Checking API routes vs architecture.md..."
grep -E "app\.(get|post|put|delete)\(" apps/backend/src/app.ts | \
  sed "s/.*'\(\/api\/[^']*\)'.*/\1/" | \
  grep "^/api/" | sort -u | while read -r route; do
    if ! grep -qF "$route" docs/architecture.md 2>/dev/null; then
      err "Route '$route' is in app.ts but not in docs/architecture.md"
    fi
  done

# ─── 3. No references to deleted files ──────────────────────────────────────

echo "Checking for stale references to deleted files..."
for stale in \
  "auth/otp.ts" "auth/jwt.ts" "auth/mailer.ts" \
  "nodemailer" "JWT_SECRET" "SMTP_HOST" \
  "claude-audit.md" "RESEARCH.md" "ctx.postman_collection.json" \
  "dashdirect"; do
  # docs/archive/, docs/audit-tracker.md, and the new audit-2026-*
  # artifacts deliberately preserve some of these names in their
  # historical narratives + audit evidence — exclude them so the check
  # only fires on *active* docs where the reference would be a live bug.
  # (Audit evidence is append-only post-capture per
  # docs/audit-2026-evidence/README.md so we cannot rephrase it.)
  matches=$(grep -rn "$stale" docs/ AGENTS.md apps/*/AGENTS.md packages/*/AGENTS.md 2>/dev/null \
    | grep -v "node_modules\|__tests__\|docs/archive/\|docs/audit-tracker.md\|docs/audit-2026-tracker.md\|docs/audit-2026-adversarial-plan.md\|docs/audit-2026-evidence/\|scripts/lint-docs.sh" \
    || true)
  if [ -n "$matches" ]; then
    err "Stale reference to '$stale' in docs"
  fi
done

# ─── 4. No references to wrong domain ───────────────────────────────────────

echo "Checking for stale domain references..."
# Cover every contributor-facing doc and every versioned config where a
# URL could land: root + package READMEs, AGENTS guides, workflow files,
# .env.example, fly.toml, capacitor.config.ts. Missing any of these
# would let the pre-rename `loop.app` sneak back in via an overlooked
# surface.
stale_domains=$(grep -rn "loop\.app" \
  README.md \
  AGENTS.md \
  apps/*/AGENTS.md apps/*/README.md apps/*/fly.toml apps/*/capacitor.config.ts \
  packages/*/AGENTS.md \
  docs/ .github/ apps/backend/.env.example \
  2>/dev/null | grep -v "node_modules" || true)
if [ -n "$stale_domains" ]; then
  err "Stale 'loop.app' reference found (should be loopfinance.io)"
fi

# ─── 5. Shared index.ts exports point to real files ─────────────────────────

echo "Checking shared package exports..."
grep "from './" packages/shared/src/index.ts | sed "s/.*from '\.\/\([^']*\)'.*/\1/" | \
  sed 's/\.js$/.ts/' | while read -r f; do
    if [ ! -f "packages/shared/src/$f" ]; then
      err "Shared index.ts exports './$f' but file does not exist"
    fi
  done

# ─── 5b. No hardcoded Stellar secret keys anywhere in tracked files ─────────
#
# Stellar secret seeds are 56-char Base32 strings starting with 'S'. A
# pre-audit helper (`scripts/pay-order.mjs`, finding A-001) had one
# hardcoded; catch any future regression before it gets committed.
# Scan tracked files only — ignored artifacts are fine, the repo is what
# we audit. Exclude tests/fixtures/docs that use the literal "S" + 55
# A's as an obviously-fake placeholder.

echo "Checking for hardcoded Stellar secret keys..."
# `git ls-files -z` lists tracked files; grep scans across all of them
# for the seed pattern. `-E` + `S[A-Z2-7]{55}` catches real 56-char
# Base32 seeds. Originally used `-P` (Perl regex) + `\b` word boundaries,
# but BSD grep on macOS rejects `-P`, the stderr was suppressed by
# `2>/dev/null`, and `|| true` swallowed the non-zero exit — producing
# a silent false-negative on every maintainer's laptop. CI on Ubuntu
# (GNU grep) would still catch it, but the local-verify guarantee was
# broken. `-E` with `{55}` is portable across BSD and GNU grep. The
# lost `\b` boundary is acceptable: a 56-char Base32 suffix that happens
# to start with S is still very likely a leaked secret worth flagging.
# Exclude docs/ (examples), .gitignore history note, CHANGELOG, and
# common placeholder strings.
stellar_secret_hits=$(git ls-files -z \
  | xargs -0 grep -nHE 'S[A-Z2-7]{55}' 2>/dev/null \
  | grep -v "docs/\|.gitignore\|CHANGELOG" \
  | grep -vE "S[A]{55}|SAMPLE|EXAMPLE" \
  || true)
if [ -n "$stellar_secret_hits" ]; then
  err "Possible hardcoded Stellar secret seed in tracked file(s):"
  echo "$stellar_secret_hits" >&2
fi

# ─── 6. No removed credentials in source (outside tests) ────────────────────

echo "Checking for removed credential references..."
# GIFT_CARD_API_KEY and GIFT_CARD_API_SECRET are legitimate — used for /locations endpoint
# Check for truly removed credentials only
removed_creds=$(grep -rn "JWT_SECRET\|JWT_REFRESH_SECRET\|SMTP_HOST\|SMTP_PORT\|SMTP_USER\|SMTP_PASS\|EMAIL_FROM" apps/backend/src/ apps/web/app/ packages/shared/src/ 2>/dev/null | grep -v "node_modules\|__tests__" || true)
if [ -n "$removed_creds" ]; then
  err "Reference to removed credential (JWT/SMTP) found in source"
fi

# ─── 7. Key source files exist (prevents AGENTS.md from referencing ghosts) ─

echo "Checking critical source files exist..."
critical_files=(
  "apps/backend/src/app.ts"
  "apps/backend/src/index.ts"
  "apps/backend/src/env.ts"
  "apps/backend/src/upstream.ts"
  "apps/backend/src/circuit-breaker.ts"
  "apps/backend/src/logger.ts"
  "apps/backend/src/discord.ts"
  "apps/backend/src/openapi.ts"
  "apps/backend/src/auth/handler.ts"
  "apps/backend/src/orders/handler.ts"
  "apps/backend/src/merchants/sync.ts"
  "apps/backend/src/merchants/handler.ts"
  "apps/backend/src/clustering/algorithm.ts"
  "apps/backend/src/clustering/data-store.ts"
  "apps/backend/src/clustering/handler.ts"
  "apps/backend/src/images/proxy.ts"
  "apps/web/app/routes.ts"
  "apps/web/app/root.tsx"
  "apps/web/app/utils/security-headers.ts"
  "apps/web/app/native/secure-storage.ts"
  "apps/mobile/scripts/apply-native-overlays.sh"
  "packages/shared/src/index.ts"
  "packages/shared/src/api.ts"
  "packages/shared/src/merchants.ts"
  "packages/shared/src/orders.ts"
  "packages/shared/src/search.ts"
  "packages/shared/src/slugs.ts"
)
for f in "${critical_files[@]}"; do
  if [ ! -f "$f" ]; then
    err "Critical file '$f' does not exist"
  fi
done

# ─── 8. Fly deploy configs validate cleanly ─────────────────────────────────
#
# The health-check bug caught in PR #120 — `[[services.http_checks]]` orphaned
# under a `[http_service]` root — would have been caught by
# `flyctl config validate` the moment it regressed. Running the validator
# here keeps every fly.toml in the repo from drifting into a shape Fly's
# scheduler silently ignores. Skip cleanly on machines without flyctl so
# this doesn't break fresh contributor laptops; CI installs it (see
# `.github/workflows/ci.yml`) before the docs-lint step.
#
# `flyctl config validate` requires auth to resolve the referenced app.
# In CI we don't wire FLY_API_TOKEN (deploys are manual from a maintainer
# laptop), so treat the "no access token" case the same way we treat
# "flyctl not installed" — a skip with a warning, not a hard failure.
echo "Checking Fly deploy configs..."
if command -v flyctl >/dev/null 2>&1; then
  while IFS= read -r fly_toml; do
    dir=$(dirname "$fly_toml")
    output=$(cd "$dir" && flyctl config validate 2>&1 || echo "FLYCTL_FAILED")
    if echo "$output" | grep -q "no access token available"; then
      echo "  (flyctl installed but not authenticated — skipping $fly_toml; run 'flyctl auth login' to enable this check)"
      continue
    fi
    if echo "$output" | grep -q "FLYCTL_FAILED"; then
      echo "$output" | sed 's/^/  /' >&2
      err "flyctl config validate failed for $fly_toml"
    elif echo "$output" | grep -qi "warning"; then
      echo "$output" | sed 's/^/  /' >&2
      err "flyctl config validate emitted a warning for $fly_toml"
    fi
  done < <(find apps -maxdepth 3 -name "fly.toml" -not -path "*/node_modules/*")
else
  echo "  (flyctl not installed — skipping; install from https://fly.io/docs/flyctl/install/)"
fi

# ─── Done ───────────────────────────────────────────────────────────────────

echo ""
errors=$(cat "$ERROR_FILE")
rm -f "$ERROR_FILE"
if [ "$errors" -gt 0 ]; then
  echo "FAILED: $errors documentation issue(s) found."
  exit 1
else
  echo "OK: All documentation checks passed."
fi
