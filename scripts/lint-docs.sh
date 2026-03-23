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
for stale in "auth/otp.ts" "auth/jwt.ts" "auth/mailer.ts" "nodemailer" "JWT_SECRET" "SMTP_HOST"; do
  matches=$(grep -rn "$stale" docs/ AGENTS.md apps/*/AGENTS.md packages/*/AGENTS.md 2>/dev/null | grep -v "node_modules\|__tests__" || true)
  if [ -n "$matches" ]; then
    err "Stale reference to '$stale' in docs"
  fi
done

# ─── 4. No references to wrong domain ───────────────────────────────────────

echo "Checking for stale domain references..."
stale_domains=$(grep -rn "loop\.app" docs/ AGENTS.md apps/*/AGENTS.md .github/ apps/backend/.env.example 2>/dev/null | grep -v "node_modules" || true)
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

# ─── 6. No removed credentials in source (outside tests) ────────────────────

echo "Checking for removed credential references..."
cred_refs=$(grep -rn "GIFT_CARD_API_SECRET\|X-Api-Secret" apps/backend/src/ apps/web/app/ packages/shared/src/ 2>/dev/null | grep -v "node_modules\|__tests__" || true)
if [ -n "$cred_refs" ]; then
  err "Reference to removed GIFT_CARD_API_SECRET found in source"
fi

# ─── 7. Key source files exist (prevents AGENTS.md from referencing ghosts) ─

echo "Checking critical source files exist..."
critical_files=(
  "apps/backend/src/app.ts"
  "apps/backend/src/index.ts"
  "apps/backend/src/env.ts"
  "apps/backend/src/upstream.ts"
  "apps/backend/src/circuit-breaker.ts"
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
  "packages/shared/src/index.ts"
  "packages/shared/src/api.ts"
  "packages/shared/src/merchants.ts"
  "packages/shared/src/orders.ts"
  "packages/shared/src/slugs.ts"
)
for f in "${critical_files[@]}"; do
  if [ ! -f "$f" ]; then
    err "Critical file '$f' does not exist"
  fi
done

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
