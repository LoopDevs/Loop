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
# A4-116: lock down permissions — these files carry GIFT_CARD_API_*,
# DISCORD_WEBHOOK_*, VITE_SENTRY_DSN, etc. Default `cp` mode is 644
# (world-readable) on most umasks; tighten so only your account can
# read them.
chmod 600 apps/backend/.env apps/web/.env.local

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
# ── Runtime ──────────────────────────────────────────────────────────
PORT=8080
LOG_LEVEL=info                          # trace | debug | info | warn | error | fatal | silent
NODE_ENV=development
# A2-1310: logical-env tag for Sentry bucketing. Pair with VITE_LOOP_ENV
# on the web side. Staging deploys that run NODE_ENV=production should
# set LOOP_ENV=staging so events still bucket as staging, not production.
# LOOP_ENV=staging

# ── Upstream CTX (ADR 013) ───────────────────────────────────────────
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

# CTX operator-account pool (ADR 013). JSON array of service accounts
# used as CTX-side customers when fulfilling Loop-native orders. At
# least one entry must have `id` + `bearer`. Absent → Loop-native
# order fulfillment is blocked (merchant browse still works).
# CTX_OPERATOR_POOL=[{"id":"primary","bearer":"eyJ..."},{"id":"backup-1","bearer":"eyJ..."}]

# ── Merchant sync (ADR 021) ──────────────────────────────────────────
# A2-1922: comma-separated CTX merchant IDs filtered out of the catalog
# at sync time — Loop's operator deny-list. Denied IDs never reach the
# in-memory store, the public API, or the admin catalog.
# LOOP_MERCHANT_DENYLIST=merchant-id-1,merchant-id-2
REFRESH_INTERVAL_HOURS=6                # merchant cache refresh
LOCATION_REFRESH_INTERVAL_HOURS=24      # location data refresh
# INCLUDE_DISABLED_MERCHANTS=true       # dev mode — show disabled merchants

# ── Database (ADR 012) ───────────────────────────────────────────────
# Required in production. The dev default points at the docker-compose
# Postgres instance — see `docker-compose.yml` at the repo root.
DATABASE_URL=postgres://loop:loop@localhost:5433/loop
# DATABASE_POOL_MAX=10                   # default 10
# A2-724: per-session statement_timeout (ms) sent on every connection
# so a runaway query can't monopolise a pool slot. 0 disables.
# DATABASE_STATEMENT_TIMEOUT_MS=30000

# ── Admin gate + write invariants (ADR 017 / 018) ────────────────────
# Comma-separated CTX user IDs allowed to hit /api/admin/*. Absent →
# admin surface is locked (401 Unauthorized on every admin endpoint).
# ADMIN_CTX_USER_IDS=abc-123-xyz,def-456-uvw
# CF-30: native-auth admin allowlist (ADR 013). Comma-separated verified
# emails granted admin on the Loop-native path — ADMIN_CTX_USER_IDS is
# keyed on ctx_user_id, which native users never carry, so this is the
# only way to reach /api/admin/* when LOOP_AUTH_NATIVE_ENABLED=true.
# Case-insensitive; granted only on an OTP/provider-verified email.
# ADMIN_EMAILS=ops@loopfinance.io,admin@loopfinance.io

# A2-1610: per-admin per-currency daily cap on credit adjustments,
# in minor units. Default 100000000 (1,000,000 units minor =
# $10,000 / £10,000 / €10,000). A single admin exceeding the cap
# inside a rolling 24h window gets a 403 with `code: 'DAILY_CAP_EXCEEDED'`.
# ADMIN_DAILY_ADJUSTMENT_CAP_MINOR=100000000

# ── Default cashback split (ADR 010 / 011) ───────────────────────────
# Fallbacks used when a merchant has no row in merchant_cashback_configs.
# Keep at 0 in dev / staging — a non-zero default will silently credit
# test purchases. Configure per-merchant via the admin UI instead.
# DEFAULT_USER_CASHBACK_PCT_OF_CTX=0.00
# DEFAULT_LOOP_MARGIN_PCT_OF_CTX=0.00

# ── Observability (A2-1606 / A2-1607 / A2-1310 / A2-1327) ────────────
# Shared-secret bearer tokens. Set either → endpoint requires
# `Authorization: Bearer <token>` on every request.
#
# A4-120: closed-by-default in production. When NODE_ENV=production
# and the corresponding *_BEARER_TOKEN is unset, the endpoint
# returns 404 (probe-gate.ts) so a misconfigured prod doesn't
# silently expose Prometheus metrics or the OpenAPI spec. In
# development the endpoint is public when unset, which keeps local
# Grafana / Bruno workflows working without forcing a token.
# Use 32+ random chars.
# METRICS_BEARER_TOKEN=<32+ random chars>      # gates /metrics
# OPENAPI_BEARER_TOKEN=<32+ random chars>      # gates /openapi.json

# Discord webhooks (optional)
# DISCORD_WEBHOOK_ORDERS=https://discord.com/api/webhooks/...
# DISCORD_WEBHOOK_MONITORING=https://discord.com/api/webhooks/...
# ADR 017 / 018 admin-write audit fanout. Fire-and-forget AFTER DB
# commit; never blocks the admin write.
# DISCORD_WEBHOOK_ADMIN_AUDIT=https://discord.com/api/webhooks/...

# Error tracking (optional)
# SENTRY_DSN=https://xxx@yyy.ingest.sentry.io/zzz
# A2-1309: release tag for Sentry events (paired with VITE_SENTRY_RELEASE
# on web). CI/CD sets the git SHA; leave unset locally so dev runs don't
# poison the release pivot in Sentry.
# SENTRY_RELEASE=<git-sha or v1.2.3+sha>

# ── Security posture (audit A-023 / A-025 / test-only) ───────────────
# Image proxy SSRF allowlist — REQUIRED in production (audit A-025).
# Comma-separated upstream hostnames. Boot fails in production if unset
# unless DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT=1.
# IMAGE_PROXY_ALLOWED_HOSTS=spend.ctx.com,ctx-spend.s3.us-west-2.amazonaws.com

# Path to an operator-provided MaxMind GeoLite2-Country .mmdb (ADR 033),
# powering the GET /api/public/geo first-guess for the region selector.
# In prod it's baked into the image at build time (the Dockerfile sets
# this path — see docs/deployment.md GeoLite2 section). Unset → /geo
# returns the US default and the web client falls back to
# navigator.language. Optional locally; only needed to test geo wiring.
# MAXMIND_GEOLITE2_PATH=/etc/loop/GeoLite2-Country.mmdb

# Rate-limit trust boundary (audit A-023). Set TRUST_PROXY=true only
# when running behind a trusted edge proxy that rewrites
# X-Forwarded-For (Fly.io, Cloudflare, etc.). Otherwise leave unset so
# the rate limiter falls back to the TCP socket address that clients
# cannot spoof.
# TRUST_PROXY=true

# Test-only escape hatch. Read by playwright.mocked.config.ts and the
# e2e fixtures so 10-req/min gates don't trip the suite. Never set in
# production — it is an input to env.ts that bypasses the rate limiter
# entirely.
# DISABLE_RATE_LIMITING=1

# ── Loop-native auth (ADR 013 / 014) ─────────────────────────────────
# HS256 signing key; ≥32 chars. Absent → Loop-native auth endpoints
# are inert and CTX-proxy auth is the only path. `_PREVIOUS` is only
# set during a rotation window so in-flight access tokens signed with
# the old key still verify.
# LOOP_JWT_SIGNING_KEY=...(≥32 chars)
# LOOP_JWT_SIGNING_KEY_PREVIOUS=...(≥32 chars)

# Feature flag. When true + the signing key is set, /request-otp /
# /verify-otp / /refresh take the Loop-native path (Loop sends the
# email, mints its own JWTs).
# LOOP_AUTH_NATIVE_ENABLED=true

# Phase 1 launch gate. When true, the web client hides every Phase 2+
# surface (cashback navbar links, /settings/wallet, /settings/cashback,
# /cashback, the onboarding currency picker + wallet-intro screens,
# "you've earned X cashback" copy). Discount badges stay — they ARE the
# Phase 1 user proposition. UI-side equivalent of the backend Phase 2
# gates (LOOP_WORKERS_ENABLED / LOOP_AUTH_NATIVE_ENABLED /
# INTEREST_APY_BASIS_POINTS — keep those off in a Phase 1 deploy too).
# Flip back to false to launch cashback — server-side only, no app store
# resubmission. Default false.
# LOOP_PHASE_1_ONLY=true

# Admin step-up auth (ADR 028 / A4-063). ≥32 chars, deliberately
# separate from LOOP_JWT_SIGNING_KEY so a JWT-key compromise doesn't
# widen to step-up. Absent → boot succeeds but the destructive admin
# endpoints (credit-adjust / withdrawals / payout-retry) fail closed
# with 503 STEP_UP_UNAVAILABLE. `_PREVIOUS` only during rotation.
# LOOP_ADMIN_STEP_UP_SIGNING_KEY=...(≥32 chars)
# LOOP_ADMIN_STEP_UP_SIGNING_KEY_PREVIOUS=...(≥32 chars)

# Gift-card redeem-secret envelope key (CF-25 / X-PRIV-03). 32 bytes as
# base64 or hex (`openssl rand -base64 32`). Set → AES-256-GCM encrypts
# orders.redeem_code + redeem_pin at rest (redeem_url stays plaintext —
# it's the redemption landing page, not the bearer secret). Absent →
# plaintext storage (legacy) + a single boot warn. Backward-safe: old
# plaintext rows and key-unset writes pass through decrypt untouched, so
# setting the key activates encryption for new writes with no backfill.
# Keep separate from the JWT/step-up keys.
# LOOP_REDEEM_ENCRYPTION_KEY=...(32-byte base64 or hex)

# ── Transactional email (ADR 013) ────────────────────────────────────
# Dev default is the `console` stub (logs the OTP to stdout — grab the
# code from `npm run dev:backend` output). Production refuses to boot
# with `console`/unset when NODE_ENV=production (A2-571); set `resend`
# + an API key before flipping LOOP_AUTH_NATIVE_ENABLED in prod.
# EMAIL_PROVIDER=resend
# RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxx
# EMAIL_FROM_ADDRESS=noreply@loopfinance.io   # default; domain must be DKIM/SPF-verified
# EMAIL_FROM_NAME=Loop                        # default
# Optional Reply-To so user replies land in a monitored inbox instead
# of bouncing off the no-reply sender. Unset → reply_to omitted from
# the send. Email-validated at boot by env.ts.
# EMAIL_REPLY_TO_ADDRESS=hello@loopfinance.io

# Social login (ADR 014). Verified server-side against Google /
# Apple's issuer keys. Omit a platform to disable it.
# GOOGLE_OAUTH_CLIENT_ID_WEB=<web-client>.apps.googleusercontent.com
# GOOGLE_OAUTH_CLIENT_ID_IOS=<ios-client>.apps.googleusercontent.com
# GOOGLE_OAUTH_CLIENT_ID_ANDROID=<android-client>.apps.googleusercontent.com
# APPLE_SIGN_IN_SERVICE_ID=io.loopfinance.app

# ── Stellar / LOOP-asset rails (ADR 010 / 015 / 016) ─────────────────
# Loop's Stellar deposit address (operator account) is where users send
# XLM / USDC for Loop-native orders. The three LOOP-asset issuers back
# the cashback payouts (USDLOOP / GBPLOOP / EURLOOP — one per home
# currency). Omit an issuer → cashback for that currency stays off-chain.
# LOOP_STELLAR_DEPOSIT_ADDRESS=G...(55 chars)
# LOOP_STELLAR_USDC_ISSUER=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
# LOOP_STELLAR_USDLOOP_ISSUER=G...
# LOOP_STELLAR_GBPLOOP_ISSUER=G...
# LOOP_STELLAR_EURLOOP_ISSUER=G...

# Horizon endpoint (A2-1513 / A2-1525). Default `https://horizon.stellar.org`.
# Override for staging → Testnet Horizon. Required through env.ts so a
# bad URL fails parseEnv at boot rather than the first live call.
# LOOP_STELLAR_HORIZON_URL=https://horizon.stellar.org

# Price / FX feed overrides (A2-1812). XLM-in-home-currency + fiat FX
# oracles — keep on the CoinGecko / Frankfurter defaults in production
# unless a deployment has its own pinned oracle. Response shape must
# match CoinGecko + Frankfurter formats respectively.
# LOOP_XLM_PRICE_FEED_URL=https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd,gbp,eur
# LOOP_FX_FEED_URL=https://api.frankfurter.app/latest?from=USD&to=GBP,EUR

# Procurement USDC-floor (ADR 015). Stroops (7 decimals; 10^7 = 1 USDC).
# When the operator account's USDC balance dips below this many stroops,
# procurement pays CTX in XLM instead — unblocks fulfillment during ops
# top-ups. Absent → fallback disabled, procurement always pays USDC.
# LOOP_STELLAR_USDC_FLOOR_STROOPS=50000000000   # 5,000 USDC

# Payout signing (ADR 016). Operator secret signs outbound LOOP-asset
# payments from the operator account to user wallets. Never logged
# (pino redaction). Absent → the payout worker is inert; pending_payouts
# stay `pending` until an operator ticks the worker. Use the PREVIOUS
# slot during rotation windows only.
# LOOP_STELLAR_OPERATOR_SECRET=S...(55 chars)
# LOOP_STELLAR_OPERATOR_SECRET_PREVIOUS=S...

# Stellar network passphrase (ADR 016). Public mainnet is the default;
# override with the Testnet string for staging.
# LOOP_STELLAR_NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015

# ── Workers (ADR 010 / 015 / 016 / A2-602 / A2-905) ──────────────────
# Feature flag. Default false — a fresh clone doesn't auto-start
# Horizon + CTX polling. Set true once the operator account + issuers
# are configured above.
# LOOP_WORKERS_ENABLED=true

# Per-worker cadences. Watcher runs every 10s (deposit latency),
# procurement every 5s (user-blocking once an order is paid). Payout
# interval matches Stellar ledger-close cadence.
# LOOP_PAYMENT_WATCHER_INTERVAL_SECONDS=10
# LOOP_PROCUREMENT_INTERVAL_SECONDS=5
# LOOP_PAYOUT_WORKER_INTERVAL_SECONDS=30
# LOOP_PAYOUT_MAX_ATTEMPTS=5                   # bounded retry

# A2-1921 fee-bump strategy. Attempt N pays BASE * MULTIPLIER^(N-1),
# capped at CAP, so congested-network submits drain instead of going
# terminal at base fee.
# LOOP_PAYOUT_FEE_BASE_STROOPS=100
# LOOP_PAYOUT_FEE_MULTIPLIER=2
# LOOP_PAYOUT_FEE_CAP_STROOPS=100000

# A2-602 watchdog. Rows stuck in `submitted` past this many seconds
# are requeued (idempotent — the memo-check in the submit path will
# noop if the tx already landed).
# LOOP_PAYOUT_WATCHDOG_STALE_SECONDS=300

# ADR 015 drift watcher. Walks every LOOP asset, compares on-chain
# issuance against the off-chain ledger liability, posts Discord if
# the delta exceeds the threshold (stroops; 7 decimals).
# LOOP_ASSET_DRIFT_WATCHER_INTERVAL_SECONDS=300
# LOOP_ASSET_DRIFT_THRESHOLD_STROOPS=100000000   # 10 LOOP-asset units

# A2-905 / ADR 009 interest accrual. Off by default — a non-zero APY
# with an un-tuned ledger will silently inflate balances. When in
# doubt keep all three at the defaults.
# INTEREST_APY_BASIS_POINTS=0                  # 250 = 2.50% APY
# INTEREST_PERIODS_PER_YEAR=365                # daily
# INTEREST_TICK_INTERVAL_HOURS=24              # how often the worker ticks

# ADR 009/015 interest forward-mint pool. Daily accrual sub-allocates
# from this pre-minted on-chain pool; defaults to the operator account
# when unset. The pool watcher pages Discord monitoring when cover
# drops below the days threshold.
# LOOP_INTEREST_POOL_ACCOUNT=G...(55 chars)
# LOOP_INTEREST_POOL_MIN_DAYS_COVER=7

# ── Runtime kill switches (A2-1907) ──────────────────────────────────
# Set any to `true` and the matching surface returns 503
# SUBSYSTEM_DISABLED on the next request — no redeploy. Runbook:
# docs/runbooks/kill-switch.md. All default false.
# LOOP_KILL_ORDERS=false         # POST /api/orders + /api/orders/loop (combined)
# LOOP_KILL_ORDERS_LEGACY=false  # POST /api/orders only; unset → falls back to LOOP_KILL_ORDERS
# LOOP_KILL_ORDERS_LOOP=false    # POST /api/orders/loop only; unset → falls back to LOOP_KILL_ORDERS
# LOOP_KILL_AUTH=false           # request/verify-otp + social (refresh/logout stay open)
# LOOP_KILL_WITHDRAWALS=false    # admin withdrawal + compensation endpoints
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
npm run audit            # explicit audit policy gate: fail on any high/critical or unapproved moderate advisory
npm run build            # production build across all workspaces
npm run proto:generate   # buf generate → packages/shared/src/proto/
npm run verify           # typecheck + lint + format:check + lint:docs +
                         # shared-type-parity (ADR 019 drift detector) +
                         # openapi-parity + env-perms + test + audit — the
                         # one-command gate; mirrors the CI quality +
                         # unit-test jobs
npm run check:bundle-budget    # web SSR bundle size gate (A2-1711); run after
                               # `npm run build -w @loop/web`. CI runs it in the
                               # build job right after the SSR build.
npm run check:openapi-parity   # static route-mount ↔ openapi registration parity
                               # (missing registrations / missing 429s / 403-vs-404
                               # on /api/admin). Allowlist for deferred violations:
                               # scripts/openapi-parity-allowlist.json (empty today).
npm run check:migration-parity # replays migrations 0000→latest into a scratch DB
                               # and diffs the catalog against schema.ts (drizzle-kit
                               # materialisation). Needs a disposable postgres via
                               # DATABASE_URL (defaults to the docker-compose dev DB
                               # on :5433); CI runs it in flywheel-integration.
                               # Allowlist: scripts/migration-parity-allowlist.json.
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
npm run build            # tsup → dist/ (bundles @loop/shared in; proto types split into a dynamic-import chunk)
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

npm run sync                           # wraps `cap sync` + native overlays
npx cap open ios                       # open Xcode
npx cap open android                   # open Android Studio
```

`npm run sync` is the required path after any `cap add` or web-build
change. It runs `cap sync` and then re-applies the A-033 / A-034
overlay files from `apps/mobile/native-overlays/` so regeneration
cannot silently drop them. See `docs/mobile-native-ux.md`
§Native-config overlays.

**Live reload during mobile development:**

1. Edit `apps/mobile/capacitor.config.ts` — temporarily add `server: { url: 'http://<local-ip>:5173' }`
2. `cd apps/web && npm run dev`
3. `cd apps/mobile && npm run sync && npx cap open ios`
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
