# AGENTS.md — Loop

> Agent/contributor cockpit. Per-package guides: `apps/backend/AGENTS.md`,
> `apps/web/AGENTS.md`, `packages/shared/AGENTS.md`.

## What we're building

**Loop** — cross-platform gift-card discount app. Users buy discounted
gift cards; CTX (the supplier at spend.ctx.com) is the payment
processor (ADR 052): Loop creates the card at CTX acting-as the
customer, the customer pays CTX directly in crypto, and Loop mirrors
the card's status locally. Loop's cut is the commission spread; the
user's cashback is delivered as CTX's native checkout discount.
Single brand only. Currently UNDEPLOYED — no live environment, no
migrations, no legacy data.

## Architecture (one-liner per layer)

```
apps/mobile      Capacitor v8 shell — loads static web build from disk
apps/web         React Router v7 + Vite — SSR for loopfinance.io, static export for mobile
apps/backend     TypeScript + Hono — CTX interop (catalog, orders, auth), clustering, images
packages/shared  Shared TypeScript wire types (Merchant, Order, cluster + public shapes)
tools/ctx-catalog CTX catalog operator tooling (supplier pulls, media pipeline, QC)
database         Document store — in-memory hydrated from a JSON file (default) or MongoDB
upstream API     CTX at spend.ctx.com — merchant catalog, gift-card create/status, ws topics
```

**Database.** `apps/backend/src/db/` is a small document-store
abstraction (`store.ts`) with two drivers: `memory-store.ts` (whole
db in memory, hydrated from / flushed to `DB_JSON_PATH`, the default)
and `mongo-store.ts` (`DB_DRIVER=mongo` + `MONGODB_URI`). Collections
and unique specs live in `db/types.ts`. There are NO migrations —
the project is undeployed; change `db/types.ts` and move on.

**Auth has two paths.** Loop-native (ADR 013, default via
`LOOP_AUTH_NATIVE_ENABLED=true`): backend mints its own JWTs (RS256 +
JWKS publish when `LOOP_JWT_RSA_PRIVATE_KEY` is set; HS256 otherwise),
generates OTPs, sends email. Legacy CTX-proxy: backend forwards auth
calls to upstream. Both paths coexist until the takeover completes.

**Orders.** `POST /api/orders/loop` inserts the local mirror doc,
creates the gift card at CTX, and relays CTX's payment instructions.
The giftcard ws maintainer + mirror sweep move the local doc through
`unpaid → paid → fulfilled` (or `rejected | refunded | expired`) in
lock-step with CTX.

## Quick commands

```bash
npm run dev                  # web dev server + backend in watch mode
npm run dev:backend          # Hono API (tsx watch) on :8080 — no database needed
npm run verify               # typecheck + lint + format:check + test + audit
npm test                     # unit tests across all packages (vitest)
npm run test:integration -w @loop/backend   # backend flow tests (in-memory store)
npm run test:e2e             # Playwright mocked-CTX e2e (self-contained)
npm run build                # build backend + web
npm run mobile:sync          # cap sync + re-apply native overlays (ADR 007)
```

## Critical rules

1. **Web is a pure API client.** All data via TanStack Query against
   `apps/backend`. Only documented exceptions: `routes/sitemap.tsx`
   and `routes/home-geo-redirect.tsx` (ADR 034).
2. **All upstream CTX responses are Zod-validated** before forwarding.
3. **All Capacitor plugin calls live in `apps/web/app/native/`.**
4. **No `any`** except the dynamically-imported proto bridge.
5. **NEVER hardcode secrets** — env vars only (`.env.example` is the
   authoritative env reference; keep it in sync with `env.ts`).
6. Access tokens: memory only. Refresh tokens: Keychain /
   EncryptedSharedPreferences on native (ADR 006), sessionStorage on web.
7. Auth and order-path changes get human review before merge.
8. Never use `--no-verify` — fix the root cause.

## Git workflow

- **One PR in flight at a time.** Branch from fresh `main`, small PRs,
  squash-merge, delete the branch, pull, next.
- **Never push directly to `main`** — required CI checks: Quality,
  Unit tests, Security audit, Build verification, E2E (mocked CTX).
- Conventional Commits; commitlint runs server-side on PRs.

## What NOT to do

- Fetch data in web server-side loaders (see rule 1 exceptions)
- Install Expo or React Native packages
- Call CTX directly from the web app (always via backend)
- Commit `.env`, signing certificates, or provisioning profiles
- Add multi-brand / white-label logic — Loop only
- Merge with failing tests or lint errors
