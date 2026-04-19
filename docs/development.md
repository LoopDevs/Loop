# Development Guide

## Prerequisites

- Node.js ≥ 22
- npm ≥ 10 (bundled with Node 22)
- Xcode (iOS builds) / Android Studio (Android builds)
- `buf` CLI (only if modifying `.proto` files): installed as dev dep, use `npx buf`

---

## First-time setup

```bash
# 1. Clone and install
git clone <repo-url> loop-app
cd loop-app
npm install          # installs all workspaces

# 2. Create env files (see sections below)
cp apps/backend/.env.example apps/backend/.env
cp apps/web/.env.local.example apps/web/.env.local
# Edit both files with real values

# 3. Generate protobuf types (only needed if proto files changed)
npm run proto:generate

# 4. Start everything
npm run dev          # backend on :8080, web on :5173
```

---

## Environment variables

### apps/web/.env.local (development only, git-ignored)

```bash
VITE_API_URL=http://localhost:8080

# Error tracking (optional — get DSN from sentry.io)
# VITE_SENTRY_DSN=https://xxx@yyy.ingest.sentry.io/zzz
```

### apps/web/.env.production (committed, safe — no secrets)

```bash
VITE_API_URL=https://api.loopfinance.io
```

**Rule**: `VITE_*` vars are inlined at build time and visible in the browser bundle. Never put secrets here.

### apps/backend/.env (git-ignored)

`apps/backend/.env.example` is the authoritative source of every variable
with descriptions. Keep this snapshot in sync when you add a new var —
the `scripts/lint-docs.sh` check fails CI if a variable is in
`env.ts` but absent from `.env.example`, but this page is updated by
hand.

```bash
PORT=8080
LOG_LEVEL=info                          # debug | info | warn | error
NODE_ENV=development

# Upstream Gift Card API (public — no auth needed)
GIFT_CARD_API_BASE_URL=https://spend.ctx.com

# Optional upstream API credentials — needed only for /locations endpoint
# GIFT_CARD_API_KEY=...
# GIFT_CARD_API_SECRET=...

# Per-platform CTX client IDs — default to the @loop/shared constants
# (loopweb / loopios / loopandroid). Override per-deployment; the
# boot-time parseEnv warns on divergence from the shared defaults
# because the web bundle bakes those client IDs in at build time.
# CTX_CLIENT_ID_WEB=loopweb
# CTX_CLIENT_ID_IOS=loopios
# CTX_CLIENT_ID_ANDROID=loopandroid

# Refresh intervals (optional)
REFRESH_INTERVAL_HOURS=6                # merchant cache refresh
LOCATION_REFRESH_INTERVAL_HOURS=24     # location data refresh

# Dev mode — show disabled merchants so UI can be tested before CTX enables them.
# INCLUDE_DISABLED_MERCHANTS=true

# Image proxy SSRF allowlist — REQUIRED in production (audit A-025).
# Comma-separated upstream hostnames. Boot fails in production if unset
# unless DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT=1.
# IMAGE_PROXY_ALLOWED_HOSTS=spend.ctx.com,ctx-spend.s3.us-west-2.amazonaws.com

# Rate-limit trust boundary (audit A-023). Set TRUST_PROXY=true only
# when running behind a trusted edge proxy that rewrites
# X-Forwarded-For (Fly.io, Cloudflare, etc.). Otherwise leave unset so
# the rate limiter falls back to the TCP socket address that clients
# cannot spoof.
# TRUST_PROXY=true

# Discord webhooks (optional — for notifications)
# DISCORD_WEBHOOK_ORDERS=https://discord.com/api/webhooks/...
# DISCORD_WEBHOOK_MONITORING=https://discord.com/api/webhooks/...

# Error tracking (optional — get DSN from sentry.io)
# SENTRY_DSN=https://xxx@yyy.ingest.sentry.io/zzz
```

### Inheritance model

There is **no cross-app env inheritance**. Each app declares its own variables:

- `apps/web` knows only `VITE_API_URL` — points to wherever the backend runs
- `apps/backend` owns all backend secrets
- `packages/shared` has no runtime env vars (types only)

This keeps each app deployable independently.

---

## Dev commands

### Root (runs across all packages)

```bash
npm run dev              # web + backend concurrently
npm run dev:web          # web only
npm run dev:backend      # backend only
npm run typecheck        # tsc --noEmit across all workspaces
npm run lint             # ESLint across all workspaces
npm run lint:fix         # ESLint with auto-fix
npm run lint:docs        # ./scripts/lint-docs.sh (env/arch/fly-toml drift checks)
npm run format           # Prettier write
npm run format:check     # Prettier check (CI uses this)
npm test                 # vitest run (backend + web; shared has no runtime code to test)
npm run test:coverage    # vitest run --coverage across workspaces
npm run test:e2e         # Playwright e2e — self-contained mocked suite (alias)
npm run test:e2e:mocked  # Playwright e2e — same mocked suite, explicit name
npm run test:e2e:real    # Playwright e2e — against a running real-CTX backend
npm run audit            # npm audit --audit-level=high
npm run build            # production build across all workspaces
npm run proto:generate   # buf generate → packages/shared/src/proto/
npm run verify           # typecheck + lint + format:check + lint:docs + test — the
                         # one-command gate; mirrors the CI quality + unit-test jobs
```

### apps/web

```bash
npm run dev              # React Router dev server (SSR mode) on :5173
npm run build            # SSR production build
npm run build:mobile     # Static export for Capacitor (BUILD_TARGET=mobile)
npm start                # Serve SSR build locally
npm run typecheck        # react-router typegen + tsc --noEmit
npm test                 # vitest run (single-run)
npm run test:watch       # vitest (watch mode — re-runs on file change)
npm run test:coverage    # vitest run --coverage
```

### apps/backend

```bash
npm run dev              # tsx watch src/index.ts — hot reload
npm run build            # tsup → dist/ (bundles @loop/shared into one file)
npm start                # node dist/index.js (production)
npm test                 # vitest run (single-run)
npm run test:watch       # vitest (watch mode — re-runs on file change)
npm run test:coverage    # vitest run --coverage
npm run typecheck        # tsc --noEmit
```

### apps/mobile (after building web)

```bash
cd apps/web && npm run build:mobile    # build static export first
cd apps/mobile

# First time only: generate the native projects. They're gitignored
# (see ADR-007) — regenerated with `cap add`, updated with `cap sync`.
npx cap add ios                        # once per checkout
npx cap add android                    # once per checkout

npx cap sync                           # copy web build + sync plugins
./scripts/apply-native-overlays.sh     # MUST run after every `cap add`
                                       # or `cap sync` — re-applies the
                                       # audited A-033 / A-034 config
                                       # that regeneration would drop
npx cap open ios                       # open Xcode
npx cap open android                   # open Android Studio
```

Rerun `./scripts/apply-native-overlays.sh` after any `cap add` or
`cap sync` to keep the A-033 backup exclusions and the A-034 Face ID
usage description in place — both are enforced by overlay files in
`apps/mobile/native-overlays/`. See `docs/mobile-native-ux.md`
§Native-config overlays.

**Live reload during mobile development:**

1. Edit `apps/mobile/capacitor.config.ts` — temporarily add `server: { url: 'http://<local-ip>:5173' }`
2. `cd apps/web && npm run dev`
3. `cd apps/mobile && npx cap sync && ./scripts/apply-native-overlays.sh && npx cap open ios`
4. Remove `server.url` before committing

---

## Proto types

Protobuf schema: `apps/backend/proto/clustering.proto`
Generated output: `packages/shared/src/proto/`

Regenerate whenever the proto schema changes:

```bash
npm run proto:generate
```

Both web and backend perform a dynamic import of proto types with JSON fallback — the app works without generated types (falls back to JSON responses).

---

## Commit format

Conventional Commits enforced via commitlint + Husky:

```
<type>(<scope>): <description>

Types:  feat | fix | refactor | perf | test | docs | chore | ci | build | revert
Scopes: web | mobile | backend | shared | infra | deps | ci
```

Examples:

```
feat(web): add merchant search filter
fix(backend): correct cluster centroid calculation
chore(deps): bump react-router to 7.7.1
```

---

## Branching

- `main` — always deployable. GitHub branch protection is active (audit A-037 closed once the repo went public): required passing checks are Quality, Unit tests, Security audit, Build verification, and E2E tests (mocked CTX); force-push and branch deletion are blocked. See `docs/standards.md §15 CI/CD` for the exact ruleset.
- `feat/<ticket>-description` — feature work
- `fix/<ticket>-description` — bug fixes

All changes via PR. Never push directly to `main`.
