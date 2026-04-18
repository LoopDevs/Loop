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

See `apps/backend/.env.example` for all variables with descriptions.

```bash
PORT=8080
LOG_LEVEL=info                          # debug | info | warn | error
NODE_ENV=development

# Upstream Gift Card API (public — no auth needed)
GIFT_CARD_API_BASE_URL=https://spend.ctx.com

# Refresh intervals (optional)
REFRESH_INTERVAL_HOURS=6                # merchant cache refresh
LOCATION_REFRESH_INTERVAL_HOURS=24     # location data refresh

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
npm run format           # Prettier write
npm run format:check     # Prettier check (CI uses this)
npm test                 # vitest run across all workspaces
npm run test:e2e         # Playwright e2e tests
npm run build            # production build across all workspaces
npm run proto:generate   # buf generate → packages/shared/src/proto/
```

### apps/web

```bash
npm run dev              # React Router dev server (SSR mode) on :5173
npm run build            # SSR production build
npm run build:mobile     # Static export for Capacitor (BUILD_TARGET=mobile)
npm start                # Serve SSR build locally
npm run typecheck        # react-router typegen + tsc --noEmit
npm test                 # vitest run
npm run test:coverage    # vitest run --coverage
```

### apps/backend

```bash
npm run dev              # tsx watch src/index.ts — hot reload
npm run build            # tsc → dist/
npm start                # node dist/index.js (production)
npm test                 # vitest run
npm run test:coverage    # vitest run --coverage
npm run typecheck        # tsc --noEmit
```

### apps/mobile (after building web)

```bash
cd apps/web && npm run build:mobile    # build static export first
cd apps/mobile

# First time only: generate the native projects. They're gitignored
# (see ADR-007) — the overlay script below re-applies the audited
# config that `cap sync` would otherwise overwrite.
npx cap add ios                        # once per checkout
npx cap add android                    # once per checkout
./scripts/apply-native-overlays.sh     # after every `cap add` / `cap sync`

npx cap sync                           # copy web build + sync plugins
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
3. `cd apps/mobile && npx cap sync && npx cap open ios`
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
Scopes: web | mobile | backend | shared | infra | deps
```

Examples:

```
feat(web): add merchant search filter
fix(backend): correct cluster centroid calculation
chore(deps): bump react-router to 7.7.1
```

---

## Branching

- `main` — always deployable, protected
- `feat/<ticket>-description` — feature work
- `fix/<ticket>-description` — bug fixes

All changes via PR. Never push directly to `main`.
