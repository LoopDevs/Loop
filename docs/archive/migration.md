# Loop — Migration Plan

> **HISTORICAL (A2-1808).** This is the original monorepo-assembly
> plan. The migration completed long ago; live architecture lives in
> [`docs/architecture.md`](../architecture.md) and the ADR tree
> ([`docs/adr/`](../adr/)). Several targets described below have been
> superseded since this doc was written — most notably the auth module
> (which now mints its own HS256 JWTs and maintains a CTX operator
> pool per ADR-013, rather than proxying CTX tokens as originally
> planned) and the data layer (Postgres credits ledger per ADR-009 +
> ADR-012, which post-dates this plan entirely). Do not treat the
> contents as current guidance. Moved from `docs/migration.md` on
> 2026-04-24.

Setting up the Loop monorepo from scratch and migrating existing codebases in as clean, standards-compliant packages.

---

## Overview

The monorepo consolidates three existing projects:

| Source                         | Destination        | Notes                                                         |
| ------------------------------ | ------------------ | ------------------------------------------------------------- |
| Existing React Router web app  | `apps/web/`        | Rebranded to Loop, white-label removed, API client refactored |
| Existing Go clustering service | `apps/backend/`    | Ported to TypeScript (Hono), clustering logic preserved       |
| (new)                          | `apps/mobile/`     | Capacitor shell, built fresh                                  |
| (new)                          | `packages/shared/` | Shared TypeScript types, built fresh                          |

All source code entering the monorepo must pass the full standards defined in `docs/standards.md` before being considered done. No legacy code is merged as-is.

---

## Phase 0 — Monorepo scaffold

Set up the workspace before any existing code is touched.

- [ ] Initialise `loop-app` as an npm workspace with `apps/*` and `packages/*`
- [ ] Configure root `package.json` with workspace scripts: `typecheck`, `lint`, `test`, `build`
- [ ] Add root `tsconfig.base.json` with strict settings (see `docs/standards.md §3`)
- [ ] Configure ESLint v9 flat config at root, extended per package
- [ ] Configure Prettier at root (`.prettierrc`)
- [ ] Add Husky + lint-staged + commitlint
- [ ] Add `.github/workflows/ci.yml` — typecheck, lint, test (with coverage), build, security audit
- [ ] Scaffold `packages/shared/` — `package.json`, `tsconfig.json`, `src/index.ts`
- [ ] Scaffold `apps/mobile/` — Capacitor config pointing at `../web/build/client`
- [ ] Add root `.gitignore` covering all build outputs, `node_modules/`, native build artefacts
- [ ] Write the three ADRs in `docs/adr/` (already done)

**Exit criteria:** `npm run lint`, `npm run typecheck`, and `npm run test` all pass on an empty codebase. CI pipeline runs green.

---

## Phase 1 — Migrate web app → `apps/web/`

### Step 1.1 — Copy source files

Copy the `app/` directory and config files into `apps/web/`. Do not copy:

- `node_modules/`, `build/`, `merchants.db`
- Any legacy brand config, database, or scheduler files (see step 1.2)
- Any unrelated media files

### Step 1.2 — Remove legacy code

**Delete these files entirely — do not migrate them:**

| File                            | Reason                                      |
| ------------------------------- | ------------------------------------------- |
| `lib/brand-config.ts`           | White-label system — Loop is the only brand |
| `lib/database.ts`               | SQLite merchant cache — moves to backend    |
| `lib/scheduler.ts`              | Cron sync — moves to backend                |
| `app/contexts/BrandContext.tsx` | White-label context — no longer needed      |
| `app/welcome/`                  | Framework template placeholder              |
| `REFACTORING_PLAN.md`           | Stale legacy doc                            |
| `REFACTOR_COMPLETE.md`          | Stale legacy doc                            |
| `WHITE_LABEL_SETUP.md`          | White-label doc — Loop is single-brand      |

### Step 1.3 — Branding removal

Replace all legacy brand references across `apps/web/`. Every item in this table must produce zero grep results before Phase 1 is complete.

#### Text replacements

| Find                                 | Replace                          | Notes                             |
| ------------------------------------ | -------------------------------- | --------------------------------- |
| `Stellar Spend`                      | `Loop`                           |                                   |
| `StellarSpend`                       | `Loop`                           |                                   |
| `stellarspend`                       | `loop`                           |                                   |
| `Dash Spend`                         | `Loop`                           |                                   |
| `DashSpend`                          | `Loop`                           |                                   |
| `dashspend`                          | `loop`                           |                                   |
| `stellarspend.com`                   | `loopfinance.io`                 |                                   |
| `dashspend.com`                      | `loopfinance.io`                 |                                   |
| `Save money with Stellar`            | `Save money every time you shop` | Tagline                           |
| Any hardcoded upstream API URL       | `import.meta.env.VITE_API_URL`   | Web never calls upstream directly |
| Any hardcoded clustering service URL | `import.meta.env.VITE_API_URL`   |                                   |

#### Assets to replace

| Remove                     | Replace with       |
| -------------------------- | ------------------ |
| `stellarspend-logo.svg`    | `loop-logo.svg`    |
| `stellarspend-favicon.ico` | `loop-favicon.ico` |
| `stellarspend-favicon.png` | `loop-favicon.png` |
| `dashspend-logo.svg`       | (delete)           |
| `dashspend-favicon.ico`    | (delete)           |
| `dashspend-favicon.png`    | (delete)           |

Loop brand assets must be created before this step can be completed.

#### Branding audit (run before marking Phase 1 done)

```bash
grep -ri "stellarspend" apps/ packages/ --include="*.ts" --include="*.tsx" --include="*.json" --include="*.md"
grep -ri "dashspend" apps/ packages/ --include="*.ts" --include="*.tsx" --include="*.json" --include="*.md"
grep -ri "stellar spend" apps/ packages/ --include="*.ts" --include="*.tsx"
grep -ri "dash spend" apps/ packages/ --include="*.ts" --include="*.tsx"
```

All commands must return zero results. These checks run in CI permanently — they cannot regress.

### Step 1.4 — Refactor: pure API client

The web app must be a pure API client. Remove all server-side data access.

**`app/routes/home.tsx`** — server-side loader calls a local database:

- Remove the database call from the `loader` function
- Replace with TanStack Query fetching `GET /api/merchants` from the backend

**`app/routes/gift-card.$name.tsx`** — likely has server-side merchant lookup:

- Same pattern: remove, replace with TanStack Query

**Delete these route files** — their API logic moves to `apps/backend/`:

- `app/routes/api.sync.ts`
- `app/routes/api.merchants.$id.ts`
- `app/routes/api.search.ts`

**`app/components/ClientOnlyMap.tsx`** — hardcodes upstream service URLs and uses an inline proto schema string:

- Replace hardcoded service URLs with `import.meta.env.VITE_API_URL`
- Replace inline proto schema string with generated types from `@loop/shared`
- Replace `protobufjs` with `@bufbuild/protobuf`

**`package.json`** — remove:

- `better-sqlite3`, `@types/better-sqlite3`
- `node-cron`, `@types/node-cron`

Add:

- `@bufbuild/protobuf`

(`@tanstack/react-query` is already present.)

### Step 1.5 — Add build mode flag

`react-router.config.ts`:

```typescript
export default {
  ssr: process.env.BUILD_TARGET !== 'mobile',
};
```

`package.json`:

```json
"build:mobile": "BUILD_TARGET=mobile react-router build"
```

### Step 1.6 — Replace `useAppMode` with `useNativePlatform`

The existing `useAppMode` hook uses `localStorage` — this violates the security rules for mobile. Replace with the Capacitor-aware `useNativePlatform`:

```typescript
// app/hooks/use-native-platform.ts
import { Capacitor } from '@capacitor/core';
import { useState, useEffect } from 'react';

export function useNativePlatform() {
  const [isNative, setIsNative] = useState(false);
  const [platform, setPlatform] = useState<'ios' | 'android' | 'web'>('web');

  useEffect(() => {
    setIsNative(Capacitor.isNativePlatform());
    setPlatform(Capacitor.getPlatform() as 'ios' | 'android' | 'web');
  }, []);

  return { isNative, platform };
}
```

Remove all `localStorage.setItem('appMode', ...)` calls.

### Step 1.7 — Apply standards

Run through the full standards checklist:

- ESLint: zero errors
- `tsc --noEmit`: zero errors
- File naming: all files `kebab-case`
- No `any` types (or annotated `// TODO: type properly`)
- No `console.log`
- JSDoc on all exported functions
- All async functions have error handling

### Step 1.8 — Tests

Write tests to reach coverage thresholds:

- `app/services/api-client.test.ts` — mock HTTP, cover all API functions
- `app/hooks/use-native-platform.test.ts` — mock Capacitor
- `app/hooks/use-merchants.test.ts`
- `app/hooks/use-purchase-flow.test.ts`

**Phase 1 exit criteria:**

- [ ] `npm run lint` — zero errors
- [ ] `npm run typecheck` — zero errors
- [ ] `npm test` — passing, coverage thresholds met
- [ ] `npm run build` (SSR) — succeeds
- [ ] `npm run build:mobile` (static export) — succeeds
- [ ] Branding audit — zero results
- [ ] No direct calls to any upstream service URL in web source code

---

## Phase 2 — Build `apps/backend/`

Port the existing Go clustering service to TypeScript and extend with the full Loop backend API.

### Step 2.1 — Scaffold

- Hono server entry point (`src/index.ts`)
- TypeScript config extending root `tsconfig.base.json`
- `Dockerfile`
- Pino logger setup
- Environment variable config
- Dev command: `tsx watch src/index.ts`

### Step 2.2 — Port clustering logic

The clustering service performs grid-based geographic clustering. Port this logic precisely — do not optimise or change behaviour during the port. Get it working identically first.

Key files:

- `src/clustering/algorithm.ts` — grid clustering, zoom-adaptive grid sizes
- `src/clustering/data-store.ts` — in-memory location store, periodic refresh
- `src/clustering/handler.ts` — Hono route handler, protobuf/JSON response switching
- `src/images/proxy.ts` — image fetch, resize via `sharp`, LRU cache
- `src/merchants/sync.ts` — upstream API fetch with pagination
- `src/merchants/handler.ts` — merchant list and detail endpoints

**Clustering grid sizes to preserve exactly:**

| Zoom | Grid size                         |
| ---- | --------------------------------- |
| ≤ 3  | 20.0°                             |
| ≤ 5  | 10.0°                             |
| 6    | 5.0°                              |
| ≤ 7  | 1.5°                              |
| ≤ 9  | 0.5°                              |
| ≤ 11 | 0.1°                              |
| ≤ 13 | 0.03°                             |
| ≥ 14 | No clustering (individual points) |

Write a comparison test that feeds identical location data to both the old and new implementations and asserts identical output. This prevents silent behavioural regression.

### Step 2.3 — Generate protobuf types into `packages/shared/`

- Copy `clustering.proto` into `apps/backend/proto/`
- Configure `buf.gen.yaml` to generate TypeScript types into `packages/shared/src/proto/`
- Run `npx buf generate`
- Export generated types from `packages/shared/src/index.ts`

### Step 2.4 — Auth module

- `POST /api/auth/request-otp` — generate 6-digit OTP, store with 10-minute expiry, send email
- `POST /api/auth/verify-otp` — validate OTP, issue JWT access + refresh token pair
- `POST /api/auth/refresh` — validate refresh token, issue new access token
- `DELETE /api/auth/session` — invalidate refresh token
- JWT middleware for protected routes

### Step 2.5 — Orders module

- `POST /api/orders` — validate, proxy to upstream gift card API, return result
- `GET /api/orders` — order history for authenticated user
- `GET /api/orders/:id` — single order

### Step 2.6 — Tests

- `src/clustering/algorithm.test.ts` — every zoom level, edge cases (empty, single point, overlapping coordinates), comparison test against reference output
- `src/auth/otp.test.ts` — generation, expiry, validation, replay prevention
- `src/merchants/sync.test.ts` — pagination, error recovery

**Phase 2 exit criteria:**

- [ ] `npm run lint` — zero errors
- [ ] `npm run typecheck` — zero errors
- [ ] `npm test` — passing, coverage thresholds met
- [ ] `npm run build` — runnable server
- [ ] Clustering output matches reference for identical input
- [ ] Protobuf responses parse correctly with `@bufbuild/protobuf` shared types

---

## Phase 3 — Integration

### Step 3.1 — Wire web app to backend

- Set `VITE_API_URL=http://localhost:8080` in `apps/web/.env.local`
- Confirm all `apps/web/app/services/api-client.ts` calls resolve correctly
- Confirm map protobuf response parses with `@bufbuild/protobuf` shared types from `@loop/shared`

### Step 3.2 — Capacitor shell (`apps/mobile/`)

- Initialise Capacitor in `apps/mobile/`
- Set `webDir: '../web/build/client'` in `capacitor.config.ts`
- Add core Capacitor packages: `@capacitor/core`, `@capacitor/cli`, `@capacitor/app`, `@capacitor/haptics`, `@capacitor/splash-screen`, `@capacitor/push-notifications`
- Run `npx cap add ios && npx cap add android`
- Build static export: `cd apps/web && npm run build:mobile`
- Sync: `cd apps/mobile && npx cap sync`
- Test on physical device (not simulator only)

### Step 3.3 — End-to-end tests

- Auth: email → OTP → home
- Purchase: merchant → denomination → pay → confirmation
- Map: loads, clusters render, zoom to individual pins

### Step 3.4 — Decommission legacy deployments

Once the Loop backend is running in production and the web app is confirmed pointing to it:

- Retire the old clustering service deployment
- Archive the source repositories (do not delete — retain as reference)

---

## Definition of done (all phases)

A phase is not complete until every item is true:

- [ ] `npm run lint` — zero errors across all packages
- [ ] `npm run typecheck` — zero errors across all packages
- [ ] `npm test` — all passing, all coverage thresholds met
- [ ] All build targets succeed
- [ ] Branding audit — zero legacy brand strings in source
- [ ] CI pipeline green on `main`
- [ ] Any new API endpoints documented in `docs/architecture.md`
- [ ] Any architectural decisions documented in `docs/adr/`
- [ ] Code reviewed
