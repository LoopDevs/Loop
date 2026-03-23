# AGENTS.md — Loop

> AI agent cockpit view. For deep dives, follow the links in **Docs index** below.

## Docs index

| Doc                    | Contents                                               |
| ---------------------- | ------------------------------------------------------ |
| `docs/architecture.md` | System design, data flows, component responsibilities  |
| `docs/development.md`  | Getting started, env vars, all dev commands            |
| `docs/deployment.md`   | How to deploy backend, web, and mobile                 |
| `docs/testing.md`      | Testing pyramid, when tests run, coverage requirements |
| `docs/standards.md`    | Code style, commit format, branching, review rules     |
| `docs/roadmap.md`      | What's left for Phase 1, Phase 2, Phase 3              |
| `docs/adr/`            | Architecture Decision Records                          |

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

**Auth is proxied, not custom.** Backend forwards login/verify/refresh to upstream CTX API. Tokens are upstream tokens — backend does not issue its own JWTs. See `docs/architecture.md` for full auth flow.

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
cd apps/mobile && npx cap sync && npx cap open ios

# Code quality
npm run verify               # typecheck + lint + test (one command)
npm run typecheck            # tsc across all packages
npm run lint                 # ESLint across all packages
npm run format               # Prettier across all packages

# Tests
npm test                     # Unit tests across all packages (vitest)
npm run test:e2e             # Playwright end-to-end tests

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
- **Access tokens: memory only** (Zustand). Refresh tokens: Capacitor Preferences on native, sessionStorage on web.
- **NEVER** store or transmit Stellar private keys from backend. Generated on-device, stays on-device.
- **ALL** auth, payment, and Stellar code requires human review before merge.
- **NEVER** use `--no-verify` to skip hooks — fix the root cause.

---

## File boundaries (web)

| Path              | Responsibility                                            |
| ----------------- | --------------------------------------------------------- |
| `app/routes/`     | Route definitions, page layout, meta                      |
| `app/components/` | Presentational — no direct API calls                      |
| `app/hooks/`      | Stateful logic (useAuth, useMerchants, useNativePlatform) |
| `app/services/`   | Typed API client — one function per endpoint              |
| `app/native/`     | All Capacitor plugin interactions                         |
| `app/stores/`     | Zustand — session and UI state                            |

## File boundaries (backend)

| Path                     | Responsibility                                      |
| ------------------------ | --------------------------------------------------- |
| `src/app.ts`             | Hono app creation, middleware, route registration   |
| `src/index.ts`           | Server startup only — `serve()` + background tasks  |
| `src/auth/handler.ts`    | Auth proxy to upstream CTX (login, verify, refresh) |
| `src/orders/handler.ts`  | Order proxy to upstream CTX (create, list, get)     |
| `src/merchants/`         | Merchant catalog sync + API handlers                |
| `src/clustering/`        | Location sync, grid clustering algorithm, handler   |
| `src/images/proxy.ts`    | Image resize proxy with LRU cache + SSRF protection |
| `src/circuit-breaker.ts` | Shared circuit breaker for all upstream calls       |
| `src/upstream.ts`        | Upstream URL builder helper                         |
| `src/env.ts`             | Zod-validated environment config                    |

## Shared package (`packages/shared/`)

| Concern                                 | Location                       |
| --------------------------------------- | ------------------------------ |
| TypeScript types (Merchant, Order, API) | `packages/shared/src/*.ts`     |
| Slug generation                         | `packages/shared/src/slugs.ts` |
| Error codes and API constants           | `packages/shared/src/api.ts`   |
| Protobuf generated types                | `packages/shared/src/proto/`   |

Before creating a utility in `apps/web` or `apps/backend`, check if it already exists in shared or should be added there.

---

## Environment variables (summary)

```bash
# apps/web/.env.local (dev only, git-ignored)
VITE_API_URL=http://localhost:8080

# apps/backend/.env (git-ignored — see apps/backend/.env.example)
GIFT_CARD_API_BASE_URL=https://spend.ctx.com
# Optional:
# GIFT_CARD_API_KEY=<key>              — needed for /locations endpoint
# INCLUDE_DISABLED_MERCHANTS=true      — dev mode: show disabled merchants
```

Full env var docs → `docs/development.md`.

---

## Backend middleware stack

Applied in order on every request:

1. **CORS** — `loopfinance.io` in production, `*` in dev
2. **Secure headers** — HSTS, X-Content-Type-Options, X-Frame-Options, etc.
3. **Body limit** — 1MB max request body
4. **Request ID** — unique `X-Request-Id` on every request
5. **Logger** — access log for every request
6. **Rate limiting** — per-IP on `/api/image` (60/min) and `/api/auth/request-otp` (5/min)
7. **Circuit breaker** — shared `upstreamCircuit` on all upstream calls (5 failures → 30s open → probe)

---

## Documentation update rules

**Every code change must update the relevant docs in the same commit.** Use this checklist:

| If you changed…                            | Update…                                                              |
| ------------------------------------------ | -------------------------------------------------------------------- |
| An API endpoint (add/remove/modify)        | `docs/architecture.md` → Backend API endpoints section               |
| An env var (add/remove/rename)             | `docs/development.md`, `AGENTS.md` env summary, `.env.example` files |
| A build command or dev workflow            | `docs/development.md`, `AGENTS.md` quick commands                    |
| Deploy config (Dockerfile, Fly.io, Vercel) | `docs/deployment.md`                                                 |
| Test patterns or coverage rules            | `docs/testing.md`                                                    |
| A code convention or standard              | `docs/standards.md`                                                  |
| An architectural decision                  | Add/update `docs/adr/NNN-title.md`                                   |
| File structure (add/move/delete files)     | `AGENTS.md` file boundaries table                                    |
| `packages/shared` exports                  | Check both `apps/web` and `apps/backend` imports                     |
| Dependencies (add/remove)                  | Verify no duplicates across packages                                 |
| Middleware or backend infrastructure       | `AGENTS.md` middleware stack section                                 |

**If unsure, update `AGENTS.md`.** It is the first thing AI agents read. Stale instructions here cause cascading errors.

---

## What NOT to do

- Fetch data in server-side loaders (pure API client architecture)
- Import Capacitor plugins outside `app/native/`
- Install Expo or React Native packages
- Bypass `app/services/` with direct `fetch()` in components
- Call upstream CTX API directly from the web app (always go through backend)
- Commit `.env`, signing certificates, or provisioning profiles
- Use Web Crypto API for Stellar signing — use `@stellar/stellar-sdk`
- Add multi-brand / white-label logic — Loop only
- Push directly to `main` — all changes via PR
- Merge a PR with failing tests or lint errors
- Write a TODO without a ticket reference or date
- Import from `src/index.ts` in tests — import from `src/app.ts` instead
- Forward upstream API responses without Zod validation
