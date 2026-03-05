# AGENTS.md — Loop

> AI agent cockpit view. For deep dives, follow the links in **Docs index** below.

## Docs index

| Doc | Contents |
|-----|----------|
| `docs/architecture.md` | System design, data flows, component responsibilities |
| `docs/development.md` | Getting started, env vars, all dev commands |
| `docs/deployment.md` | How to deploy backend, web, and mobile |
| `docs/testing.md` | Testing pyramid, when tests run, coverage requirements |
| `docs/standards.md` | Code style, commit format, branching, review rules |
| `docs/adr/` | Architecture Decision Records |

---

## What we're building

**Loop** — cross-platform gift card cashback app. Users buy discounted gift cards (XLM, Phase 1) and earn USDC cashback to a Stellar wallet (Phase 2). Single brand only.

---

## Architecture (one-liner per layer)

```
apps/mobile   Capacitor v7 shell — loads static web build from disk
apps/web      React Router v7 + Vite — SSR for loop.app, static export for mobile
apps/backend  TypeScript + Hono — merchant cache, clustering, image proxy, auth, order proxy
packages/shared  Shared TypeScript types (Merchant, Order, ClusterResponse, etc.)
upstream API  Gift Card provider — merchant catalog, gift card orders (managed externally)
```

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
2. **All Capacitor plugin calls live in `apps/web/app/native/`.** Never import plugins in components or hooks directly.
3. **Static export constraint**: `BUILD_TARGET=mobile` → loaders cannot run server-side. Loaders do layout/meta only.
4. **Protobuf for clusters**: clients send `Accept: application/x-protobuf`. JSON is the fallback for debugging only.
5. **No `any`** except dynamically-imported proto bridge (marked `// eslint-disable-next-line`).

---

## Critical security rules

- **NEVER** hardcode secrets — env vars only.
- **Access tokens: memory only** (Zustand). Refresh tokens: Capacitor Preferences on native, sessionStorage on web.
- **NEVER** store or transmit Stellar private keys from backend. Generated on-device, stays on-device.
- **ALL** auth, payment, and Stellar code requires human review before merge.
- **NEVER** use `--no-verify` to skip hooks — fix the root cause.

---

## File boundaries (web)

| Path | Responsibility |
|------|----------------|
| `app/routes/` | Route definitions, page layout, meta |
| `app/components/` | Presentational — no direct API calls |
| `app/hooks/` | Stateful logic (useAuth, useMerchants, useNativePlatform) |
| `app/services/` | Typed API client — one function per endpoint |
| `app/native/` | All Capacitor plugin interactions |
| `app/stores/` | Zustand — session and UI state |
| `packages/shared/` | Types shared across web, mobile, backend |

---

## Environment variables (summary)

```bash
# apps/web/.env.local (dev only, git-ignored)
VITE_API_URL=http://localhost:8080

# apps/backend/.env (git-ignored — see apps/backend/.env.example)
PORT=8080
JWT_SECRET=<secret>
JWT_REFRESH_SECRET=<secret>
GIFT_CARD_API_BASE_URL=<url>
GIFT_CARD_API_KEY=<key>
GIFT_CARD_API_SECRET=<secret>
SMTP_HOST=<host>  SMTP_PORT=587  SMTP_USER=<user>  SMTP_PASS=<pass>
EMAIL_FROM=noreply@loop.app
```

Full env var docs → `docs/development.md`.

---

## Documentation update rules

**Every code change must update the relevant docs in the same commit.** Use this checklist:

| If you changed… | Update… |
|-----------------|---------|
| An API endpoint (add/remove/modify) | `docs/architecture.md` → Backend API endpoints section |
| An env var (add/remove/rename) | `docs/development.md`, `AGENTS.md` env summary, `.env.example` files |
| A build command or dev workflow | `docs/development.md`, `AGENTS.md` quick commands |
| Deploy config (Dockerfile, Fly.io, Vercel) | `docs/deployment.md` |
| Test patterns or coverage rules | `docs/testing.md` |
| A code convention or standard | `docs/standards.md` |
| An architectural decision | Add/update `docs/adr/NNN-title.md` |
| File structure (add/move/delete files) | `AGENTS.md` file boundaries table |
| `packages/shared` exports | Check both `apps/web` and `apps/backend` imports |
| Dependencies (add/remove) | Verify no duplicates across packages |

**If unsure, update `AGENTS.md`.** It is the first thing AI agents read. Stale instructions here cause cascading errors.

---

## Shared code rules

**All code used by both web and backend MUST live in `packages/shared`.** Never duplicate logic between apps.

| Shared concern | Location |
|---------------|----------|
| TypeScript types (Merchant, Order, API) | `packages/shared/src/*.ts` |
| Slug generation | `packages/shared/src/slugs.ts` |
| Error codes and API constants | `packages/shared/src/api.ts` |
| Protobuf generated types | `packages/shared/src/proto/` |

Before creating a utility in `apps/web` or `apps/backend`, check if it already exists in shared or should be added there.

---

## What NOT to do

- Fetch data in server-side loaders (pure API client architecture)
- Import Capacitor plugins outside `app/native/`
- Install Expo or React Native packages
- Bypass `app/services/` with direct `fetch()` in components
- Commit `.env`, signing certificates, or provisioning profiles
- Use Web Crypto API for Stellar signing — use `@stellar/stellar-sdk`
- Add multi-brand / white-label logic — Loop only
- Push directly to `main` — all changes via PR
- Merge a PR with failing tests or lint errors
- Write a TODO without a ticket reference or date
