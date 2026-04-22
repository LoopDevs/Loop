# AGENTS.md — Loop

> AI agent cockpit view. For deep dives, follow the links in **Docs index** below.

## Docs index

| Doc                                                         | Contents                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------- |
| `docs/architecture.md`                                      | System design, data flows, component responsibilities         |
| `docs/development.md`                                       | Getting started, env vars, all dev commands                   |
| `docs/deployment.md`                                        | How to deploy backend, web, and mobile                        |
| `docs/testing.md`                                           | Testing pyramid, when tests run, coverage requirements        |
| `docs/standards.md`                                         | Code style, commit format, branching, review rules            |
| `docs/roadmap.md`                                           | What's left for Phase 1, Phase 2, Phase 3                     |
| `docs/codebase-audit.md`                                    | Audit program, scope, evidence model, exit criteria           |
| `docs/audit-checklist.md`                                   | Detailed audit checklist by workstream                        |
| `docs/audit-tracker.md`                                     | Working tracker for evidence, findings, and status            |
| `docs/adr/`                                                 | Architecture Decision Records                                 |
| `docs/adr/005-known-limitations.md`                         | Items we deliberately do NOT fix in Phase 1                   |
| `docs/adr/006-keychain-backed-secure-storage.md`            | Keychain/EncryptedSharedPreferences for refresh tokens        |
| `docs/adr/007-native-projects-source-of-truth.md`           | Why native iOS/Android projects stay generated, not versioned |
| `docs/adr/008-capacitor-filesystem-for-share.md`            | Why share-image writes go through Filesystem on Android       |
| `docs/adr/009-credits-ledger-cashback-flow.md`              | Off-chain postgres ledger + cashback capture                  |
| `docs/adr/010-principal-switch-payment-rails.md`            | Loop becomes merchant of record; payment rails                |
| `docs/adr/011-admin-panel-cashback-configuration.md`        | Admin panel shape + cashback-config audit trail               |
| `docs/adr/012-drizzle-orm-fly-postgres.md`                  | ORM + Postgres-on-Fly stack choice                            |
| `docs/adr/013-loop-owned-auth-and-ctx-operator-accounts.md` | Loop owns user auth; CTX is a supplier pool                   |
| `docs/adr/014-social-login-google-apple.md`                 | Google + Apple social login, verified server-side             |
| `docs/adr/015-stablecoin-topology-and-payment-rails.md`     | USDLOOP/GBPLOOP/EURLOOP + USDC + XLM asset flows              |
| `docs/adr/016-stellar-sdk-payout-submit.md`                 | Stellar SDK for outbound payout submit + retry + idempotency  |
| `docs/adr/017-admin-credit-primitives.md`                   | Admin-write invariants: actor, idempotency, reason, audit     |

---

## What we're building

**Loop** — cross-platform gift card cashback app. Users buy discounted gift cards (XLM, Phase 1) and earn USDC cashback to a Stellar wallet (Phase 2). Single brand only.

---

## Architecture (one-liner per layer)

```
apps/mobile   Capacitor v8 shell — loads static web build from disk
apps/web      React Router v7 + Vite — SSR for loopfinance.io, static export for mobile
apps/backend  TypeScript + Hono — proxies upstream CTX API, caches merchants, clusters locations
packages/shared  Shared TypeScript types (Merchant, Order, ClusterResponse, etc.)
upstream API  CTX gift card provider at spend.ctx.com — merchant catalog, auth, gift card orders
```

**Auth is proxied, not custom.** Backend forwards request-otp, verify-otp, refresh, and logout to upstream CTX API. Tokens are upstream tokens — backend does not issue its own JWTs. See `docs/architecture.md` for full auth flow.

---

## Quick commands

```bash
# From repo root — runs everything concurrently
npm run dev                  # web dev server + backend in watch mode

# Per-app
npm run dev:web              # React Router dev server on :5173
npm run dev:backend          # Hono API server (tsx watch) on :8080

# Build
npm run build                # Build all packages
cd apps/web && npm run build:mobile   # Static export for Capacitor

# Mobile (after web build)
cd apps/mobile && npx cap sync && ./scripts/apply-native-overlays.sh && npx cap open ios
# apply-native-overlays.sh is idempotent; re-run after every cap sync so
# audit A-033 (Android backup rules) and A-034 (NSFaceIDUsageDescription)
# survive the native-project regeneration (ADR-007).

# Code quality
npm run verify               # typecheck + lint + format:check + lint:docs + test (one command — runs ./scripts/verify.sh)
npm run typecheck            # tsc across all packages
npm run lint                 # ESLint across all packages
npm run format               # Prettier across all packages

# Tests
npm test                     # Unit tests across all packages (vitest)
npm run test:e2e             # Playwright e2e — self-contained mocked suite (default)
npm run test:e2e:real        # Playwright e2e — requires a running real-CTX backend

# Proto
npm run proto:generate       # buf generate → packages/shared/src/proto/
```

---

## Critical architecture rules

1. **Web is a pure API client.** No server-side data fetching in loaders. All data via TanStack Query against `apps/backend`.
2. **Auth is proxied through upstream CTX.** Backend does not generate OTPs, issue JWTs, or send emails. All auth endpoints proxy to `spend.ctx.com`.
3. **All Capacitor plugin calls live in `apps/web/app/native/`.** Never import plugins in components or hooks directly.
4. **Static export constraint**: `BUILD_TARGET=mobile` → loaders cannot run server-side. Loaders do layout/meta only.
5. **Protobuf for clusters**: clients send `Accept: application/x-protobuf`. JSON is the fallback for debugging only.
6. **No `any`** except dynamically-imported proto bridge (marked `// eslint-disable-next-line`).
7. **All upstream responses are Zod-validated** before forwarding to the client.

---

## Critical security rules

- **NEVER** hardcode secrets — env vars only.
- **Access tokens: memory only** (Zustand). Refresh tokens: `@aparajita/capacitor-secure-storage` on native (Keychain / EncryptedSharedPreferences — ADR-006, audit A-024), sessionStorage on web.
- **NEVER** store or transmit Stellar private keys from backend. Generated on-device, stays on-device.
- **ALL** auth, payment, and Stellar code requires human review before merge.
- **NEVER** use `--no-verify` to skip hooks — fix the root cause.

---

## Per-package agent guides

Each package has its own `AGENTS.md` with file structure, patterns, and recipes:

| Package            | Guide                       | When to read                                  |
| ------------------ | --------------------------- | --------------------------------------------- |
| `apps/backend/`    | `apps/backend/AGENTS.md`    | Modifying API endpoints, sync, auth, orders   |
| `apps/web/`        | `apps/web/AGENTS.md`        | Modifying routes, components, hooks, services |
| `packages/shared/` | `packages/shared/AGENTS.md` | Modifying shared types, adding new types      |

**Read the relevant package guide before making changes.** It has the file structure, key patterns, and step-by-step recipes for common tasks (add endpoint, add route, add env var, etc.).

---

## Environment variables (summary)

```bash
# apps/web/.env.local (dev only, git-ignored)
VITE_API_URL=http://localhost:8080
# VITE_SENTRY_DSN=<dsn>               — optional, Sentry error tracking for web

# apps/backend/.env (git-ignored — `apps/backend/.env.example` is the
# authoritative reference; `scripts/lint-docs.sh` enforces parity with
# `env.ts`. This summary is a quick-look; keep it in sync when you add
# a new var.)
GIFT_CARD_API_BASE_URL=https://spend.ctx.com

# Production-required (audit A-025) — boot fails without it in
# NODE_ENV=production unless DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT=1
# IMAGE_PROXY_ALLOWED_HOSTS=spend.ctx.com,ctx-spend.s3.us-west-2.amazonaws.com

# Rate-limiter trust boundary (audit A-023). Set `true` only when
# behind a trusted edge proxy (Fly.io, Cloudflare) — otherwise clients
# can spoof X-Forwarded-For and bypass per-IP limits.
# TRUST_PROXY=true

# Optional: API credentials for endpoints that require auth (/locations)
# GIFT_CARD_API_KEY=<key>
# GIFT_CARD_API_SECRET=<secret>

# CTX client IDs (audit A-018) — override per-deployment; the web
# bundle bakes DEFAULT_CLIENT_IDS from @loop/shared at build time, so
# divergence emits a boot warn.
# CTX_CLIENT_ID_WEB=loopweb
# CTX_CLIENT_ID_IOS=loopios
# CTX_CLIENT_ID_ANDROID=loopandroid

# Loop-native auth (ADR 013). Absent → legacy CTX-proxy path only.
# Min 32 chars; PREVIOUS is set during rotation windows.
# LOOP_JWT_SIGNING_KEY=<at-least-32-char-random-secret>
# LOOP_JWT_SIGNING_KEY_PREVIOUS=<prior-secret-during-rotation>

# Dev mode: show disabled merchants
# INCLUDE_DISABLED_MERCHANTS=true

# Refresh cadences
# REFRESH_INTERVAL_HOURS=6
# LOCATION_REFRESH_INTERVAL_HOURS=24

# Runtime
# PORT=8080
# NODE_ENV=development
# LOG_LEVEL=info                      — trace|debug|info|warn|error|fatal|silent

# Observability
# SENTRY_DSN=<dsn>
# DISCORD_WEBHOOK_ORDERS=<url>
# DISCORD_WEBHOOK_MONITORING=<url>
```

Full env var docs → `docs/development.md`.

---

## Backend middleware stack

Applied in order on every request:

1. **CORS** — production: `loopfinance.io`, `www.loopfinance.io`, plus the Capacitor native origins (`capacitor://localhost`, `https://localhost`, `http://localhost`) so iOS and Android webview requests pass preflight. Dev: `*`. Source of truth: `PRODUCTION_ORIGINS` in `apps/backend/src/app.ts`.
2. **Secure headers** — HSTS, X-Content-Type-Options, X-Frame-Options, etc.
3. **Body limit** — 1MB max request body
4. **Request ID** — unique `X-Request-Id` on every request
5. **Logger** — Pino-backed access log for every request (audit A-021); shares service/env/redaction with application logs and correlates via `X-Request-Id`
6. **Rate limiting** — per-IP: `/api/clusters` (60/min), `/api/image` (300/min), `/api/auth/request-otp` (5/min), `/api/auth/verify-otp` (10/min), `/api/auth/refresh` (30/min), `DELETE /api/auth/session` (20/min), `POST /api/orders` (10/min), `GET /api/orders` (60/min), `GET /api/orders/:id` (120/min). 429 responses include `Retry-After`.
7. **Circuit breaker** — per-upstream-endpoint breakers (login, verify-email, refresh-token, logout, merchants, locations, gift-cards), each 5 failures → 30s open → HALF_OPEN probe. Independent so a failing `/locations` doesn't trip auth.

---

## Documentation update rules

**Every code change must update the relevant docs in the same commit.** Use this checklist:

| If you changed…                                         | Update…                                                                                                                                                                                                                           |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An API endpoint (add/remove/modify)                     | `docs/architecture.md` → Backend API endpoints section, **and** `apps/backend/src/openapi.ts` registration — declare every status code the handler can return (429 if rate-limited, 502 for upstream-proxy, 503 for circuit-open) |
| An API response shape or field                          | Shared type in `packages/shared/`, **and** the matching schema in `apps/backend/src/openapi.ts` so generated clients don't strip the field                                                                                        |
| A rate limit, Cache-Control, or middleware ordering     | `AGENTS.md` middleware stack section, **and** the 429 entry in the endpoint's `openapi.ts` registration                                                                                                                           |
| An env var (add/remove/rename)                          | `docs/development.md`, `AGENTS.md` env summary, `.env.example` files, `docs/deployment.md` env table                                                                                                                              |
| A build command or dev workflow                         | `docs/development.md`, `AGENTS.md` quick commands                                                                                                                                                                                 |
| Deploy config (Dockerfile, fly.toml) on backend AND web | Make sure both stay parity — web Dockerfile/fly drift has happened (PRs #149/#150)                                                                                                                                                |
| Deploy config (Dockerfile, Fly.io, Vercel)              | `docs/deployment.md`                                                                                                                                                                                                              |
| Test patterns or coverage rules                         | `docs/testing.md`                                                                                                                                                                                                                 |
| A code convention or standard                           | `docs/standards.md`                                                                                                                                                                                                               |
| An architectural decision                               | **Required:** Add/update `docs/adr/NNN-title.md` before implementing                                                                                                                                                              |
| A new dependency                                        | **Required:** ADR justifying the addition before `npm install`                                                                                                                                                                    |
| A Capacitor plugin used by the web runtime              | Declare in **both** `apps/web/package.json` and `apps/mobile/package.json` at the same version (PR #151) — `cap sync` discovers via workspace hoisting, but isolated installs break without the mobile declaration                |
| File structure (add/move/delete files)                  | `AGENTS.md` §Architecture (one-liner per layer) if a package's role changes, per-package `AGENTS.md` Files table always                                                                                                           |
| `packages/shared` exports                               | Check both `apps/web` and `apps/backend` imports; add the file to `packages/shared/AGENTS.md` Files                                                                                                                               |
| Dependencies (add/remove)                               | Verify no duplicates across packages                                                                                                                                                                                              |
| Middleware or backend infrastructure                    | `AGENTS.md` middleware stack section                                                                                                                                                                                              |

**If unsure, update `AGENTS.md`.** It is the first thing AI agents read. Stale instructions here cause cascading errors.

---

## Git workflow

- **Never push directly to `main`** — all changes via PR. Branch protection is now enforced by GitHub (audit A-037 closed after the repo went public): required passing status checks are `Quality (typecheck, lint, format, docs)`, `Unit tests`, `Security audit`, `Build verification`, `E2E tests (mocked CTX)`; force-push and branch deletion are blocked; stale reviews dismiss on new commits. The `gh api repos/LoopDevs/Loop/branches/main/protection` endpoint now returns the active ruleset. Admins can still squash-merge without a required approval because the project is pre-team, but the passing-checks gate is non-negotiable.
- The **real-upstream** e2e suite (`test-e2e`, Playwright against a running backend pointed at spend.ctx.com) is **PR-only**. The self-contained **mocked** e2e suite (`test-e2e-mocked`, boots mock-ctx + backend + web on isolated ports) runs on every push to main and every PR (audit A-003). So a direct push to main still gets the deterministic mocked flow, but not the upstream contract check.
- Create a feature branch, push, open a PR. CI runs seven jobs: `quality`, `test-unit`, `audit`, `build`, `test-e2e-mocked`, `test-e2e` (PR only), and `notify`.
- Discord `#loop-deployments` notifies on CI pass/fail.
- Branch protection on `main` is live and enforces the rules above via the GitHub API. To inspect or modify: `gh api repos/LoopDevs/Loop/branches/main/protection`.

---

## What NOT to do

- Push directly to `main` — all changes via PR
- Fetch data in server-side loaders (pure API client architecture)
- Import Capacitor plugins outside `app/native/`
- Install Expo or React Native packages
- Bypass `app/services/` with direct `fetch()` in components
- Call upstream CTX API directly from the web app (always go through backend)
- Commit `.env`, signing certificates, or provisioning profiles
- Use Web Crypto API for Stellar signing — use `@stellar/stellar-sdk`
- Add multi-brand / white-label logic — Loop only
- Merge a PR with failing tests or lint errors
- Write a TODO without a ticket reference or date
- Import from `src/index.ts` in tests — import from `src/app.ts` instead
- Forward upstream API responses without Zod validation
