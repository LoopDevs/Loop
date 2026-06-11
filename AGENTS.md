# AGENTS.md — Loop

> AI agent cockpit view. For deep dives, follow the links in **Docs index** below.

## Docs index

| Doc                                                         | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/architecture.md`                                      | System design, data flows, component responsibilities                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `docs/development.md`                                       | Getting started, env vars, all dev commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `docs/deployment.md`                                        | How to deploy backend, web, and mobile                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `docs/testing.md`                                           | Testing pyramid, when tests run, coverage requirements                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `docs/standards.md`                                         | Code style, commit format, branching, review rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `docs/slo.md`                                               | Availability / latency / freshness / settlement SLOs (A2-1325)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `docs/alerting.md`                                          | Paging tiers and limits of Discord-only alerting (A2-1327)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `docs/oncall.md`                                            | Two-maintainer weekly rotation, severity SLAs, incident template, post-mortem policy, customer comms (A2-1901 / A2-1902 / A2-1903)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `docs/error-codes.md`                                       | Error-code taxonomy — every `{ code, message }` + client guidance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `docs/log-policy.md`                                        | What gets logged + redacted, retention windows, access RBAC (A2-1911)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `docs/third-party-licenses.md`                              | OSS attribution — libvips, Leaflet markers, postgres driver                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `docs/roadmap.md`                                           | What's left for Phase 1, Phase 2, Phase 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `docs/audit-2026-06-30-cold/`                               | **Active audit** (2026-06-30 cold re-audit; 122 findings + dependency-sequenced remediation plan + executive summary). Found 18 of the 06-15 audit's ~30 claimed-closed findings still open/incomplete/regressed — see `executive-summary.md`. Remediation waves 0-8 merged 2026-07-01 (see `remediation-plan.md`); `needs-operator.md` is the consolidated list of what's left that needs a decision/vendor/legal input rather than more engineering. Supersedes `docs/audit-2026-06-15-cold/` (2026-06-15, 5 P0 + 31 P1), which supersedes `docs/audit-2026-05-03-claude/tracker.md` (2026-05-03, 71 findings), which supersedes `docs/audit-2026-tracker.md` (2026-04, 467 findings, per its own A4-068 banner); the pre-2026 trio (`codebase-audit.md` / `audit-checklist.md` / `audit-tracker.md`) is historical only. |
| `docs/comprehensive-audit-2026-06-11.md`                    | Comprehensive two-layer audit (every file — 1,751/1,751 — plus six cross-cutting passes; 857 findings). Part IV is the sequenced remediation plan currently in execution.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `docs/audit-2026-04-29/`                                    | Planning + execution scaffold for the new cold adversarial audit launched on 2026-04-29: plan, checklist, tracker, evidence/inventory conventions, operator handoff.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `docs/adr/`                                                 | Architecture Decision Records                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `docs/adr/005-known-limitations.md`                         | Items we deliberately do NOT fix in Phase 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `docs/adr/006-keychain-backed-secure-storage.md`            | Keychain/EncryptedSharedPreferences for refresh tokens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `docs/adr/007-native-projects-source-of-truth.md`           | Why native iOS/Android projects stay generated, not versioned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `docs/adr/008-capacitor-filesystem-for-share.md`            | Why share-image writes go through Filesystem on Android                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `docs/adr/009-credits-ledger-cashback-flow.md`              | Off-chain postgres ledger + cashback capture                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `docs/adr/010-principal-switch-payment-rails.md`            | Loop becomes merchant of record; payment rails                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `docs/adr/011-admin-panel-cashback-configuration.md`        | Admin panel shape + cashback-config audit trail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `docs/adr/012-drizzle-orm-fly-postgres.md`                  | ORM + Postgres-on-Fly stack choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `docs/adr/013-loop-owned-auth-and-ctx-operator-accounts.md` | Loop owns user auth; CTX is a supplier pool                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `docs/adr/014-social-login-google-apple.md`                 | Google + Apple social login, verified server-side                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `docs/adr/015-stablecoin-topology-and-payment-rails.md`     | USDLOOP/GBPLOOP/EURLOOP + USDC + XLM asset flows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `docs/adr/016-stellar-sdk-payout-submit.md`                 | Stellar SDK for outbound payout submit + retry + idempotency                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `docs/adr/017-admin-credit-primitives.md`                   | Admin-write invariants: actor, idempotency, reason, audit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `docs/adr/018-admin-panel-architecture.md`                  | Admin drill-down / triage / CSV compliance pattern                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `docs/adr/019-shared-package-policy.md`                     | `@loop/shared` — three-part test, re-export rule, phased adoption                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `docs/adr/020-public-api-surface.md`                        | `/api/public/*` — never-500, Cache-Control, no-PII conventions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `docs/adr/021-merchant-catalog-eviction-policy.md`          | Merchant-catalog eviction — admin fall-back / public drop / pin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `docs/adr/022-admin-drill-triplet-pattern.md`               | Fleet / per-merchant / per-user / self quartet for every metric                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `docs/adr/023-admin-mix-axis-matrix.md`                     | Mix-axis matrix pattern for `/:scope/:id/<target>-mix` endpoints                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `docs/adr/024-withdrawal-writer.md`                         | Admin withdrawal writer — USDLOOP debit + payout-queue insert                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `docs/adr/025-llm-pr-review.md`                             | LLM-assisted PR review — what gets sent to Anthropic + why it's acceptable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `docs/adr/026-tax-regulatory-reporting-data-model.md`       | Tax / regulatory reporting data model — Phase-1 CSV exports + Phase-2 jurisdiction tagging                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `docs/adr/027-mobile-platform-security.md`                  | Mobile platform security — Phase-1 deferral of SSL pinning / App Attest / Play Integrity / jailbreak-root / binary tamper, with per-control Phase-2 triggers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `docs/adr/028-admin-step-up-auth.md`                        | Admin step-up auth design — 5-min `X-Admin-Step-Up` JWT gating credit-adjust / withdrawal / payout-retry; Phase-1 design pinned, implementation deferred                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `docs/adr/029-repo-managed-ci-clis.md`                      | Why secret-bearing GitHub Actions workflows use lockfile-pinned repo-managed CLIs instead of live npm installs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `docs/adr/030-integrated-wallet-via-privy.md`               | **Proposed** — integrated cross-platform wallet via Privy embedded wallet (with dfns fallback if Privy Soroban DD fails); supersedes ADR 015's external-link model                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `docs/adr/031-per-currency-yield-architecture.md`           | **Proposed (v7)** — LOOPUSD/LOOPEUR are Loop-curated DeFindex vault shares (0% mgmt + 50% perf fee); GBPLOOP is Stellar classic 1:1-backed with **nightly on-chain 3% APY mints**; past-30-day APY + "no guarantee" disclaimer; no yield-source disclosure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `docs/adr/032-merchant-variant-grouping.md`                 | Client-side brand grouping via `@loop/shared` name parsing (1,134 tiles → 982 groups); server-side `group` field deferred                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `docs/adr/033-ip-geolocation-region-selector.md`            | MaxMind GeoLite2 + `/api/public/geo` regional first-guess; superseded by ADR 034's path-based model                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `docs/adr/034-path-based-locale-routing.md`                 | `/:country/:lang` URLs (~28 countries: Eurozone + US/GB/CA + ADR 035); SSR geo 302 at `/`, self-canonicals + reciprocal hreflang sitemap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `docs/adr/035-extended-supplier-currency-markets.md`        | Display countries for strong extended-currency markets (≥15 merchants): AE/IN/SA/AU/MX. Loop-side order path wired (CF-19): `ORDERABLE_CURRENCIES`, FX feed, migration 0037 `orders_currency_known`; gated on the external rates service serving the currency (else `CURRENCY_NOT_AVAILABLE` "coming soon")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

---

## What we're building

**Loop** — cross-platform gift card cashback app. Users buy discounted gift cards (XLM, Phase 1) and earn per-home-currency LOOP stablecoin cashback (USDLOOP / GBPLOOP / EURLOOP, ADR 015) to a Stellar wallet (Phase 2). LOOP assets are 1:1 backed by off-chain liability; Loop settles to CTX in XLM + USDC on the supplier side. Single brand only.

---

## Architecture (one-liner per layer)

```
apps/mobile      Capacitor v8 shell — loads static web build from disk
apps/web         React Router v7 + Vite — SSR for loopfinance.io, static export for mobile
apps/backend     TypeScript + Hono — proxies upstream CTX API, caches merchants, clusters locations
packages/shared  Shared TypeScript types (Merchant, Order, ClusterResponse, admin response shapes)
tools/ctx-catalog CTX catalog operator tooling (supplier pulls, allocators, media pipeline, QC) — see its README; archive/ holds consumed one-shot passes
postgres         Off-chain credits ledger (Drizzle ORM + Postgres-on-Fly, ADR 012 / ADR 009)
stellar          On-chain LOOP-asset issuance + USDC/XLM operator accounts (ADR 015 / ADR 016)
upstream API     CTX gift card provider at spend.ctx.com — merchant catalog, auth, gift card orders
```

**Auth has two paths.** Loop-native (ADR 013, default once `LOOP_AUTH_NATIVE_ENABLED=true`): backend mints its own JWTs (RS256 + `/.well-known/jwks.json` publish when `LOOP_JWT_RSA_PRIVATE_KEY` is set — ADR 030 Phase A; HS256 otherwise), generates OTPs, and sends email via the configured provider. Legacy CTX-proxy: backend forwards request-otp / verify-otp / refresh / logout to upstream `spend.ctx.com` and tokens are upstream-issued. Both paths coexist while the identity takeover rolls out. See `docs/architecture.md` + ADR-013 for the full auth flow.

**Orders have two paths.** Loop-native (ADR 010, default once `LOOP_AUTH_NATIVE_ENABLED=true` and the merchant catalog has been synced): `POST /api/orders/loop` creates the order in the off-chain ledger and the user pays via XLM / USDC / LOOP-asset against the Stellar deposit address. Loop is the merchant of record (principal switch). Legacy CTX-proxy: `POST /api/orders` forwards order creation to upstream CTX and the user pays CTX directly. Loop-native is the principal-switch path; the legacy path stays alive until the takeover rolls out fully.

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
npm run mobile:sync && cd apps/mobile && npx cap open ios
# `mobile:sync` wraps `cap sync` and re-applies the native overlays so
# audit A-033 (Android backup rules) and A-034 (NSFaceIDUsageDescription)
# survive the native-project regeneration (ADR-007).

# Code quality
npm run verify               # typecheck + lint + format:check + lint:docs + shared-type-parity + openapi-parity + env-perms + test + audit (one command — runs ./scripts/verify.sh)
npm run typecheck            # tsc across all packages
npm run lint                 # ESLint across all packages
npm run format               # Prettier across all packages

# Tests
npm test                     # Unit tests across all packages (vitest)
npm run test:e2e             # Playwright e2e — self-contained mocked suite (default)
npm run test:e2e:real        # Playwright e2e — requires a running real-CTX backend

# Perf / budget (A2-1711)
# Run after `npm run build -w @loop/web`. Fails if the SSR client dir
# exceeds MAX_SSR_KB (3300) or any single JS chunk exceeds MAX_CHUNK_KB (800).
# Enforced in CI: the `build` job runs it right after the web SSR build.
npm run check:bundle-budget  # Size-regression gate for the web SSR bundle

# Spec / schema parity gates (comprehensive audit 2026-06-11)
# Static route-mount ↔ openapi.ts registration cross-check: missing
# registrations, missing 429s on rate-limited mounts, and 403/404
# correctness on /api/admin (requireAdmin masks non-admins as 404).
# Runs in `npm run verify` + the CI quality job. Deferred violations
# go in scripts/openapi-parity-allowlist.json (currently empty).
npm run check:openapi-parity # Route ↔ OpenAPI registration parity (static)
# Replays migrations 0000→latest into a scratch DB and diffs the
# resulting catalog against schema.ts materialised by drizzle-kit.
# Needs a disposable postgres (DATABASE_URL is only the maintenance
# connection). Runs in CI's flywheel-integration job; allowlist for
# drizzle-unrepresentable shapes: scripts/migration-parity-allowlist.json.
npm run check:migration-parity # Migration chain ↔ schema.ts parity (needs postgres)

# Proto
npm run proto:generate       # buf generate → packages/shared/src/proto/ (A2-404: auto-prettier'd)
```

### Operator scripts (Phase-1 release path)

```bash
# Diff `flyctl secrets list -a <app>` against the required Tranche-1
# secret set. Exits non-zero if any required secret is missing — the
# pre-`flyctl deploy` gate. Never prints values, just key names.
./scripts/preflight-tranche-1.sh [app-name]   # default: loopfinance-api

# One-time bootstrap of the LOOP_E2E_REFRESH_TOKEN repo secret. Drives
# request-otp → operator enters OTP → verify-otp → uploads the resulting
# refresh token via `gh secret set` (token piped via stdin).
./scripts/bootstrap-e2e-refresh-token.sh \
  --backend https://api.loopfinance.io \
  --email reviewer@loopfinance.io \
  --gh-secret

# Real Tranche-1 e2e purchase — loop-native only (POST /api/orders/loop,
# state='fulfilled'). Default merchant Aerie at $0.02 USD. Workflow
# wrapper at .github/workflows/e2e-real.yml; can also run locally.
E2E_REFRESH_TOKEN=… STELLAR_TEST_SECRET_KEY=… node scripts/e2e-real.mjs
```

---

## Critical architecture rules

1. **Web is a pure API client — with two documented exceptions.** All data via TanStack Query against `apps/backend`. The only loaders that fetch server-side are `routes/sitemap.tsx` (crawlers need an XML response, not a React shell) and `routes/home-geo-redirect.tsx` (ADR 034: the `/` geo-redirect resolves the visitor's country via `/api/public/geo` and must 302 server-side, before any React renders, to kill the US flash). Any new loader-side fetch beyond these needs a comment explaining why TanStack Query doesn't fit.
2. **Auth has two coexisting paths.** Loop-native (ADR 013): backend mints its own JWTs (RS256 with JWKS publish when `LOOP_JWT_RSA_PRIVATE_KEY` is set — ADR 030 Phase A — otherwise HS256), generates OTPs, sends email. Gated on `LOOP_AUTH_NATIVE_ENABLED`. Legacy CTX-proxy: backend forwards request-otp / verify-otp / refresh / logout to `spend.ctx.com`. All upstream responses are Zod-validated before forwarding. Do NOT assume a single path when modifying auth code; both need to keep working until the takeover is complete.
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
# VITE_LOOP_ENV=staging                — A2-1310: logical-env tag for Sentry
#   bucketing. Pair with backend `LOOP_ENV`. Staging deploys that run
#   `MODE=production` should set this to `staging` on both sides so
#   Sentry events align. Unset → falls back to `import.meta.env.MODE`.

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

# CF2-10 (2026-06-30 cold audit) stopgap: rateLimitMap is in-memory and
# per-machine, so every configured per-route budget is actually
# max × (live Fly machine count). Divides every budget by this
# estimate. Default 1 (no division, same posture as TRUST_PROXY) —
# production sets this explicitly to the fleet's real machine count
# (confirmed 2 during the audit); update when that count changes.
# RATE_LIMIT_MACHINE_COUNT_ESTIMATE=2

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

# RS256 signing (ADR 030 Phase A). PKCS8 PEM RSA private key — when
# set, new Loop JWTs sign RS256 (RFC 7638 `kid` header) and the
# public keys publish at GET /.well-known/jwks.json for external
# verifiers; the HS256 keys above keep verifying outstanding tokens.
# Malformed / non-RSA PEM fails boot. Generate:
# `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048`.
# Cutover + rotation: docs/runbooks/jwt-key-rotation.md.
# LOOP_JWT_RSA_PRIVATE_KEY=<PKCS8 PEM>
# LOOP_JWT_RSA_PRIVATE_KEY_PREVIOUS=<prior PKCS8 PEM during rotation>

# Admin step-up auth (ADR 028). Absent → boot succeeds but destructive
# admin endpoints (credit-adjust / withdrawals / payout-retry) return
# 503 STEP_UP_UNAVAILABLE.
# LOOP_ADMIN_STEP_UP_SIGNING_KEY=<at-least-32-char-random-secret>

# Gift-card redeem-secret envelope key (CF-25 / X-PRIV-03). Set → AES-256-GCM
# encrypts orders.redeem_code + redeem_pin at rest (redeem_url stays plaintext).
# 32 bytes as base64/hex. Absent → plaintext storage + a single boot warn;
# backward-safe (old plaintext rows still decrypt). `openssl rand -base64 32`.
# LOOP_REDEEM_ENCRYPTION_KEY=<32-byte-base64-or-hex-secret>

# Phase 1 launch gate. true → web hides every Phase 2+ surface (cashback
# links, /settings/wallet, /settings/cashback, /cashback, onboarding
# currency picker + wallet-intro, "you've earned X" copy); discount
# badges stay. UI-side equivalent of the backend Phase 2 gates
# (LOOP_WORKERS_ENABLED / LOOP_AUTH_NATIVE_ENABLED / INTEREST_APY_BASIS_POINTS).
# Flip back to false to launch cashback — server-side only. Default false.
# LOOP_PHASE_1_ONLY=true

# Transactional email (ADR 013) — required set when
# LOOP_AUTH_NATIVE_ENABLED=true in production (`console` is dev-only).
# Reply-To is optional; email-validated at boot by env.ts.
# EMAIL_PROVIDER=resend
# RESEND_API_KEY=re_...
# EMAIL_FROM_ADDRESS=noreply@loopfinance.io     # default
# EMAIL_FROM_NAME=Loop                          # default
# EMAIL_REPLY_TO_ADDRESS=hello@loopfinance.io   # unset → reply_to omitted

# Dev mode: show disabled merchants
# INCLUDE_DISABLED_MERCHANTS=true

# Refresh cadences
# REFRESH_INTERVAL_HOURS=6
# LOCATION_REFRESH_INTERVAL_HOURS=24

# Runtime
# PORT=8080
# NODE_ENV=development
# LOG_LEVEL=info                      — trace|debug|info|warn|error|fatal|silent

# A2-207: payout submit worker (ADR 016). Default off outside production
# so a dev-mode backend doesn't submit Stellar transactions; set true in
# production + Fly staging after LOOP_STELLAR_OPERATOR_SECRET is wired.
# LOOP_WORKERS_ENABLED=true

# CF-26 / X-PRIV-07/08: auth-row retention purge sweep. Runs under
# LOOP_WORKERS_ENABLED; DELETE-only sweep of expired/consumed OTP rows
# + dead refresh-token rows past the retention grace. Runbook:
# docs/runbooks/dsr.md.
# LOOP_AUTH_ROW_PURGE_INTERVAL_HOURS=1
# LOOP_AUTH_ROW_RETENTION_DAYS=30

# A2-1907 runtime kill switches (read live from process.env, no
# redeploy). Combined orders switch plus per-path overrides — a set
# per-path var wins for its path; unset falls back to the combined.
# Runbook: docs/runbooks/kill-switch.md.
# LOOP_KILL_ORDERS=false          — POST /api/orders + /api/orders/loop
# LOOP_KILL_ORDERS_LEGACY=false   — POST /api/orders only
# LOOP_KILL_ORDERS_LOOP=false     — POST /api/orders/loop only
# LOOP_KILL_AUTH=false
# LOOP_KILL_WITHDRAWALS=false

# Observability
# SENTRY_DSN=<dsn>
# LOOP_ENV=staging                      — A2-1310: paired with VITE_LOOP_ENV;
#   overrides the Sentry `environment` tag so a staging deploy running
#   NODE_ENV=production still buckets events as `staging`. Unset →
#   falls back to NODE_ENV.
# DISCORD_WEBHOOK_ORDERS=<url>
# DISCORD_WEBHOOK_MONITORING=<url>
```

Full env var docs → `docs/development.md`.

---

## Backend middleware stack

Applied in order on every request:

1. **CORS** — production: `loopfinance.io`, `www.loopfinance.io`, `beta.loopfinance.io` (the Phase-1 beta web app served from the `loopfinance-web` Fly app — apex/www stay parked on GitHub Pages until public launch), plus the Capacitor native origins (`capacitor://localhost`, `https://localhost`) so iOS and Android webview requests pass preflight. Dev: `*`. Source of truth: `PRODUCTION_ORIGINS` in `apps/backend/src/middleware/cors.ts`. `http://localhost` was dropped under A2-1009 to close a CSRF surface from attacker-run localhost processes.
2. **Secure headers** — HSTS, X-Content-Type-Options, X-Frame-Options, etc.
3. **Body limit** — 1MB max request body; overflow returns 413 `PAYLOAD_TOO_LARGE` (A2-1005)
4. **Request ID** — unique `X-Request-Id` on every request
5. **Logger** — Pino-backed access log for every request (audit A-021); shares service/env/redaction with application logs and correlates via `X-Request-Id`
6. **Rate limiting** — per-IP, per-route. The full enumeration is the source code: every `app.get/post/put/delete` mount in `apps/backend/src/routes/**` declares its own `rateLimit('METHOD /path', max, windowMs)`. Quick-reference for the highest-traffic surfaces: `/api/clusters` (60/min), `/api/image` (300/min), `/api/merchants` (180/min), `/api/merchants/all` (60/min), `/api/merchants/by-slug/:slug` (120/min), `/api/merchants/cashback-rates` (120/min), `/api/merchants/:id` (120/min — authed), `/api/merchants/:id/cashback-rate` (120/min), `/.well-known/jwks.json` (120/min), `/api/auth/request-otp` (5/min), `/api/auth/verify-otp` (10/min), `/api/auth/refresh` (30/min), `DELETE /api/auth/session` (20/min), `POST /api/orders` (10/min), `GET /api/orders` (60/min), `GET /api/orders/:id` (120/min). Admin/payouts/credits/users/cashback-config endpoints have their own per-route limits (10–120/min, often 10/min for CSV exports). 429 responses include `Retry-After`. Don't treat this list as exhaustive — A4-001's per-route key fix is enforced in code, not docs.
7. **Circuit breaker** — per-upstream-endpoint breakers (login, verify-email, refresh-token, logout, merchants, locations, gift-cards), each 5 failures → 30s open → HALF_OPEN probe. Independent so a failing `/locations` doesn't trip auth.

---

## Documentation update rules

**Every code change must update the relevant docs in the same commit.** Use this checklist:

| If you changed…                                         | Update…                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An API endpoint (add/remove/modify)                     | `docs/architecture.md` → Backend API endpoints section, **and** `apps/backend/src/openapi.ts` registration — declare every status code the handler can return (429 if rate-limited, 502 for upstream-proxy, 503 for circuit-open; on `/api/admin/*` declare 404, never 403 — requireAdmin masks non-admins as 404). `scripts/lint-docs.sh` §9 + `scripts/check-openapi-parity.mjs` (verify + CI quality job) enforce the openapi side. |
| An API response shape or field                          | Shared type in `packages/shared/`, **and** the matching schema in `apps/backend/src/openapi.ts` so generated clients don't strip the field                                                                                                                                                                                                                                                                                             |
| A rate limit, Cache-Control, or middleware ordering     | `AGENTS.md` middleware stack section, **and** the 429 entry in the endpoint's `openapi.ts` registration                                                                                                                                                                                                                                                                                                                                |
| An env var (add/remove/rename)                          | `docs/development.md`, `AGENTS.md` env summary, `.env.example` files, `docs/deployment.md` env table                                                                                                                                                                                                                                                                                                                                   |
| A build command or dev workflow                         | `docs/development.md`, `AGENTS.md` quick commands                                                                                                                                                                                                                                                                                                                                                                                      |
| Deploy config (Dockerfile, fly.toml) on backend AND web | Make sure both stay parity — web Dockerfile/fly drift has happened (PRs #149/#150)                                                                                                                                                                                                                                                                                                                                                     |
| Deploy config (Dockerfile, Fly.io, Vercel)              | `docs/deployment.md`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Test patterns or coverage rules                         | `docs/testing.md`                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A code convention or standard                           | `docs/standards.md`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| An architectural decision                               | **Required:** Add/update `docs/adr/NNN-title.md` before implementing                                                                                                                                                                                                                                                                                                                                                                   |
| A new dependency                                        | **Required:** ADR justifying the addition before `npm install`                                                                                                                                                                                                                                                                                                                                                                         |
| A Capacitor plugin used by the web runtime              | Declare in **both** `apps/web/package.json` and `apps/mobile/package.json` at the same version (PR #151) — `cap sync` discovers via workspace hoisting, but isolated installs break without the mobile declaration                                                                                                                                                                                                                     |
| File structure (add/move/delete files)                  | `AGENTS.md` §Architecture (one-liner per layer) if a package's role changes, per-package `AGENTS.md` Files table always                                                                                                                                                                                                                                                                                                                |
| `packages/shared` exports                               | Check both `apps/web` and `apps/backend` imports; add the file to `packages/shared/AGENTS.md` Files                                                                                                                                                                                                                                                                                                                                    |
| Dependencies (add/remove)                               | Verify no duplicates across packages                                                                                                                                                                                                                                                                                                                                                                                                   |
| Middleware or backend infrastructure                    | `AGENTS.md` middleware stack section                                                                                                                                                                                                                                                                                                                                                                                                   |

**If unsure, update `AGENTS.md`.** It is the first thing AI agents read. Stale instructions here cause cascading errors.

---

## Git workflow

- **Never push directly to `main`** — all changes via PR. Branch protection is now enforced by GitHub (audit A-037 closed after the repo went public): required passing status checks are `Quality (typecheck, lint, format, docs)`, `Unit tests`, `Security audit`, `Build verification`, `E2E tests (mocked CTX)`; force-push and branch deletion are blocked; stale reviews dismiss on new commits. The `gh api repos/LoopDevs/Loop/branches/main/protection` endpoint now returns the active ruleset. Admins can still squash-merge without a required approval because the project is pre-team, but the passing-checks gate is non-negotiable.
- The **real-upstream** e2e suite (`test-e2e`, Playwright against a running backend pointed at spend.ctx.com) is **PR-only**. The self-contained **mocked** e2e suite (`test-e2e-mocked`, boots mock-ctx + backend + web on isolated ports) runs on every push to main and every PR (audit A-003). So a direct push to main still gets the deterministic mocked flow, but not the upstream contract check.
- Create a feature branch, push, open a PR. CI runs twelve jobs: `quality`, `test-unit`, `flywheel-integration` (real-postgres flywheel walk, A2-1705 phase A.1), `audit`, `secret-scan` (gitleaks, A2-206), `container-cve-scan` (trivy, A2-408), `sbom` (CycloneDX SBOM + SLSA provenance + cosign keyless signing, A2-408), `build`, `test-e2e-mocked`, `test-e2e-flywheel` (loop-native flywheel e2e), `test-e2e` (PR only), and `notify`. Only the five required checks listed above gate merge; the security jobs (gitleaks / trivy / sbom) run on every PR but are advisory while the project is pre-launch (deliberate — revisit at public launch).
- Discord `#loop-deployments` notifies on CI pass/fail.
- Branch protection on `main` is live and enforces the rules above via the GitHub API. To inspect or modify: `gh api repos/LoopDevs/Loop/branches/main/protection`.

---

## What NOT to do

- Push directly to `main` — all changes via PR
- Fetch data in server-side loaders (pure API client architecture — `sitemap.tsx` and `home-geo-redirect.tsx` are the only documented exceptions)
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
