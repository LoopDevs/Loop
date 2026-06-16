# Deployment

## Architecture

```
                    ┌──────────────┐
                    │  Fly.io      │
                    │  Anycast DNS │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │                         │
     ┌────────▼────────┐     ┌─────────▼────────┐
     │  iad (Virginia)  │     │  lhr (London)     │
     │  loopfinance-api    │     │  loopfinance-api     │
     │  loopfinance-web        │     │  loopfinance-web         │
     └──────────────────┘     └──────────────────┘
```

Users hit the nearest region automatically via Fly.io anycast routing.
No shared state between regions — each instance fetches merchants/locations independently.

---

## Backend — Fly.io

### First-time setup

```bash
# Deploy from the repo root, not `cd apps/backend` — the Dockerfile at
# apps/backend/Dockerfile copies from `packages/shared/` and the repo-
# root `package.json` / `package-lock.json`, so the docker build
# context has to be the repo root for those COPYs to resolve. The
# `--config` + `--dockerfile` flags tell Fly which fly.toml + Dockerfile
# to use while keeping the build context = cwd (repo root). Both app
# Dockerfiles keep `npm ci --ignore-scripts` in place and only rebuild
# `esbuild` explicitly in the builder stage; do not replace that with a
# blanket `npm rebuild` without re-auditing the hook surface. Audit
# A2-410 / A3-028.
fly launch --name loopfinance-api --region iad --no-deploy --config apps/backend/fly.toml --dockerfile apps/backend/Dockerfile

# Set secrets (API credentials for /locations endpoint only — the
# non-secret config like GIFT_CARD_API_BASE_URL, IMAGE_PROXY_ALLOWED_HOSTS,
# TRUST_PROXY, PORT, NODE_ENV, and LOG_LEVEL are baked into the
# apps/backend/fly.toml [env] block)
fly secrets set --config apps/backend/fly.toml \
  GIFT_CARD_API_KEY=<key> \
  GIFT_CARD_API_SECRET=<secret>

# Add EU region
fly regions add lhr --config apps/backend/fly.toml

# Deploy
fly deploy --config apps/backend/fly.toml --dockerfile apps/backend/Dockerfile
```

### Configuration

See `apps/backend/fly.toml`:

- Primary region: `iad` (Virginia, US)
- VM: 512MB shared-cpu (handles 116K locations in memory)
- Health check: `GET /health` every 15s, 30s grace period
- Auto-stop/start: machines stop when idle, start on request
- Min 1 machine per region always running
- Force HTTPS

### Environment variables

| Variable                          | Required           | Default       | Description                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | ------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GIFT_CARD_API_BASE_URL`          | Yes                | —             | CTX API base URL                                                                                                                                                                                                                                                                                                                            |
| `IMAGE_PROXY_ALLOWED_HOSTS`       | Yes (prod)         | —             | Comma-separated hostnames for the image proxy SSRF allowlist (audit A-025). Boot fails in `NODE_ENV=production` without it unless `DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT=1` is set.                                                                                                                                                     |
| `TRUST_PROXY`                     | Recommended (prod) | `false`       | Rate-limit IP trust boundary (audit A-023). Set to `true` on Fly.io so the limiter keys on X-Forwarded-For; otherwise clients can spoof their own bucket.                                                                                                                                                                                   |
| `GIFT_CARD_API_KEY`               | No                 | —             | API key for /locations                                                                                                                                                                                                                                                                                                                      |
| `GIFT_CARD_API_SECRET`            | No                 | —             | API secret for /locations                                                                                                                                                                                                                                                                                                                   |
| `CTX_CLIENT_ID_WEB`               | No                 | `loopweb`     | Client ID for web auth                                                                                                                                                                                                                                                                                                                      |
| `CTX_CLIENT_ID_IOS`               | No                 | `loopios`     | Client ID for iOS auth                                                                                                                                                                                                                                                                                                                      |
| `CTX_CLIENT_ID_ANDROID`           | No                 | `loopandroid` | Client ID for Android auth                                                                                                                                                                                                                                                                                                                  |
| `INCLUDE_DISABLED_MERCHANTS`      | No                 | `false`       | Show disabled merchants (dev-only — prod boot warns)                                                                                                                                                                                                                                                                                        |
| `LOOP_MERCHANT_DENYLIST`          | No                 | —             | A2-1922: comma-separated CTX merchant IDs filtered out of the catalog at sync time (operator deny-list). Denied IDs never enter the in-memory store, public API, or admin catalog.                                                                                                                                                          |
| `REFRESH_INTERVAL_HOURS`          | No                 | `6`           | Merchant catalog refresh cadence                                                                                                                                                                                                                                                                                                            |
| `LOCATION_REFRESH_INTERVAL_HOURS` | No                 | `24`          | Location data refresh cadence                                                                                                                                                                                                                                                                                                               |
| `DISCORD_WEBHOOK_ORDERS`          | No                 | —             | Webhook URL for order created / fulfilled notifications                                                                                                                                                                                                                                                                                     |
| `DISCORD_WEBHOOK_MONITORING`      | No                 | —             | Webhook URL for health-status and circuit-breaker alerts                                                                                                                                                                                                                                                                                    |
| `SENTRY_DSN`                      | Recommended (prod) | —             | Backend error tracking DSN                                                                                                                                                                                                                                                                                                                  |
| `SENTRY_RELEASE`                  | No (paired)        | —             | A2-1309: release tag for Sentry events. Pair with `VITE_SENTRY_RELEASE` on web. CI/CD sets it to the git SHA so Sentry can pivot from an event to the exact deploy artifact. Absent → events carry no `release` attribute.                                                                                                                  |
| `LOOP_ENV`                        | No (paired)        | `NODE_ENV`    | A2-1310: explicit logical-env tag for Sentry bucketing. Pair with `VITE_LOOP_ENV` on web. A staging deploy that runs `NODE_ENV=production` should set `LOOP_ENV=staging` on both sides so Sentry events bucket consistently across backend and web.                                                                                         |
| `PORT`                            | No                 | `8080`        | Server port                                                                                                                                                                                                                                                                                                                                 |
| `NODE_ENV`                        | No                 | `development` | Environment. Schema default is `development`; prod deployments set it to `production` explicitly (our `fly.toml` + Dockerfile both do). Audit A-025's image-proxy allowlist enforcement and the `INCLUDE_DISABLED_MERCHANTS=true` boot warn only fire when `NODE_ENV === 'production'`, so leaving it unset in prod silently disables both. |
| `LOG_LEVEL`                       | No                 | `info`        | Pino log level (`trace`/`debug`/`info`/`warn`/`error`/`fatal`/`silent`)                                                                                                                                                                                                                                                                     |

#### Auth (ADR 013 / ADR 014)

| Variable                                  | Required           | Default | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------- | ------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOOP_JWT_SIGNING_KEY`                    | Yes (prod)         | —       | 32+ char secret for HS256 signing on the Loop-native auth path (ADR 013). Rotate via `_PREVIOUS` below.                                                                                                                                                                                                                                                                                                                                                                                |
| `LOOP_JWT_SIGNING_KEY_PREVIOUS`           | No                 | —       | Prior signing key accepted during rotation. Remove after all outstanding tokens expire.                                                                                                                                                                                                                                                                                                                                                                                                |
| `LOOP_AUTH_NATIVE_ENABLED`                | No                 | `false` | Gates the Loop-native OTP path. `false` → legacy CTX-proxy. Flip to `true` per deploy in the identity takeover.                                                                                                                                                                                                                                                                                                                                                                        |
| `LOOP_PHASE_1_ONLY`                       | No                 | `false` | Phase 1 launch gate. `true` hides every Phase 2+ web surface (cashback navbar links, `/settings/wallet`, `/settings/cashback`, `/cashback`, onboarding currency picker + wallet-intro, "you've earned X" copy); discount badges stay. UI-side equivalent of the backend Phase 2 gates (`LOOP_WORKERS_ENABLED` / `LOOP_AUTH_NATIVE_ENABLED` / `INTEREST_APY_BASIS_POINTS` — keep those off too). Flip back to `false` to launch cashback — server-side only, no app-store resubmission. |
| `GOOGLE_OAUTH_CLIENT_ID_WEB`              | No                 | —       | ADR-014 social login. Absent → Google button hidden on web.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GOOGLE_OAUTH_CLIENT_ID_IOS`              | No                 | —       | ADR-014 social login, iOS.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GOOGLE_OAUTH_CLIENT_ID_ANDROID`          | No                 | —       | ADR-014 social login, Android.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `APPLE_SIGN_IN_SERVICE_ID`                | No                 | —       | ADR-014 Apple Sign-In service id.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `LOOP_ADMIN_STEP_UP_SIGNING_KEY`          | Recommended (prod) | —       | ADR-028 / A4-063: 32+ char key signing the 5-min `X-Admin-Step-Up` JWTs. **Absent → boot succeeds but destructive admin endpoints (credit-adjust / withdrawals / payout-retry) fail closed with `503 STEP_UP_UNAVAILABLE`.** Keep separate from `LOOP_JWT_SIGNING_KEY` so a JWT-key compromise doesn't widen to step-up.                                                                                                                                                               |
| `LOOP_ADMIN_STEP_UP_SIGNING_KEY_PREVIOUS` | No                 | —       | Prior step-up key accepted during rotation. Drop after the 5-minute step-up TTL elapses.                                                                                                                                                                                                                                                                                                                                                                                               |
| `LOOP_REDEEM_ENCRYPTION_KEY`              | Recommended (prod) | —       | CF-25 / X-PRIV-03: 32-byte key (base64 or hex; `openssl rand -base64 32`) for AES-256-GCM envelope encryption of `orders.redeem_code` + `redeem_pin` at rest (`redeem_url` stays plaintext). **Absent → codes/PINs are stored plaintext (legacy) + a single boot warn.** Backward-safe: old plaintext rows still decrypt, so setting the key activates encryption for new writes with no backfill. Keep separate from the JWT/step-up keys. Length-validated at boot.                  |

#### Transactional email (ADR 013)

Required as a set when `LOOP_AUTH_NATIVE_ENABLED=true` in production — the OTP path can't send mail without a real provider, and boot refuses `EMAIL_PROVIDER=console` (or unset) in production (A2-571).

| Variable                 | Required                | Default                  | Description                                                                                                                                                                             |
| ------------------------ | ----------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMAIL_PROVIDER`         | Yes (prod, native auth) | `console` (dev only)     | `resend` is the only real provider today. `console` logs OTPs to stdout — dev only; production boot throws on it.                                                                       |
| `RESEND_API_KEY`         | Yes (when `resend`)     | —                        | Resend API key (`re_…`). Never logged.                                                                                                                                                  |
| `EMAIL_FROM_ADDRESS`     | No                      | `noreply@loopfinance.io` | Sender address. Domain must be DKIM/SPF-verified at the provider before delivery succeeds.                                                                                              |
| `EMAIL_FROM_NAME`        | No                      | `Loop`                   | Display name for the From header.                                                                                                                                                       |
| `EMAIL_REPLY_TO_ADDRESS` | No                      | —                        | Optional Reply-To so user replies route to a monitored inbox (prod sets `hello@loopfinance.io` in `fly.toml [env]`). Unset → `reply_to` omitted from the send. Email-validated at boot. |

#### Database (ADR 012)

| Variable                        | Required | Default | Description                                                                                                                                   |
| ------------------------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                  | Yes      | —       | `postgres://` or `postgresql://` URL. Dev points at the docker-compose Postgres on `:5433`; prod Fly-managed.                                 |
| `DATABASE_POOL_MAX`             | No       | `10`    | Drizzle pool size per Node process. Tune if a machine hosts multiple workers.                                                                 |
| `DATABASE_STATEMENT_TIMEOUT_MS` | No       | `30000` | A2-724: per-session `statement_timeout` sent as a connection startup parameter so a runaway query can't monopolise a pool slot. `0` disables. |

##### Postgres role hygiene (A2-1614)

**Production (Fly-managed Postgres).** Loop runs against a
Fly-managed Postgres cluster. The cluster is provisioned with two
roles:

- **`loop_app`** — owns the schema, runs migrations, has read+write
  on every table. This is the role `apps/backend` connects as
  (the `DATABASE_URL` Fly secret encodes its credentials). It does
  **not** have `SUPERUSER`; cluster admin tasks (replica add, base
  backup) go through Fly's `fly postgres` CLI which uses a separate
  out-of-band role provisioned by Fly.
- **`loop_readonly`** — `SELECT` only on every table in the schema.
  Used by ad-hoc analytics + reconciliation scripts that read the DB
  without ever needing to write. Credentials live in 1Password,
  rotated quarterly.

**Connection pooling.** Drizzle holds an internal connection pool of
`DATABASE_POOL_MAX` connections per Node process (default 10). Fly's
managed Postgres exposes both a direct Postgres port and a PgBouncer
port; Loop connects to the **direct** port — Drizzle's pool already
multiplexes our queries, and PgBouncer's transaction-mode pooling
breaks the `LISTEN` / `NOTIFY` and prepared-statement features the
ledger code relies on (we do `SELECT ... FOR UPDATE` inside
`db.transaction(...)` in the credits primitives, ADR-009).

**Verifying the prod posture.** The repo can't introspect the live
DB roles, so this section is the source of truth for what ops should
configure. Drift surfaces if a migration starts failing on the
`loop_readonly` role's analytics workload — that's the smoke signal
that the role-grant wasn't extended for a new table.

#### Admin + audit (ADR 017 / ADR 018)

| Variable                           | Required    | Default        | Description                                                                                              |
| ---------------------------------- | ----------- | -------------- | -------------------------------------------------------------------------------------------------------- |
| `ADMIN_CTX_USER_IDS`               | Yes (prod)  | `''`           | Comma-separated CTX user IDs granted admin. Evaluated at user upsert; controls `users.is_admin`.         |
| `DEFAULT_USER_CASHBACK_PCT_OF_CTX` | No          | schema default | ADR 009 / 011 cashback split default.                                                                    |
| `DEFAULT_LOOP_MARGIN_PCT_OF_CTX`   | No          | schema default | ADR 009 / 011 margin split default.                                                                      |
| `ADMIN_DAILY_ADJUSTMENT_CAP_MINOR` | No          | `100_000_000`  | Per-admin-per-day magnitude cap on credit adjustments (A2-1610). 0 disables. ~1M major units at default. |
| `DISCORD_WEBHOOK_ADMIN_AUDIT`      | No          | —              | Fires on every admin write post-commit (ADR 017/018). Leave unset in dev.                                |
| `METRICS_BEARER_TOKEN`             | Recommended | —              | 16+ char token gating `/metrics` (A2-1606). Absent → endpoint returns 404.                               |
| `OPENAPI_BEARER_TOKEN`             | Recommended | —              | 16+ char token gating `/openapi.json` (A2-1607).                                                         |
| `DISABLE_RATE_LIMITING`            | No          | `false`        | Dev-only escape hatch. `parseEnv()` throws on `prod + DISABLE_RATE_LIMITING=true` (A2-1605).             |

#### Stellar rails (ADR 015 / ADR 016)

| Variable                                | Required    | Default                                            | Description                                                                           |
| --------------------------------------- | ----------- | -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `LOOP_STELLAR_DEPOSIT_ADDRESS`          | Yes (prod)  | —                                                  | Operator account receiving inbound deposits.                                          |
| `LOOP_STELLAR_OPERATOR_SECRET`          | Yes (prod)  | —                                                  | Operator signing secret for outbound payouts.                                         |
| `LOOP_STELLAR_OPERATOR_SECRET_PREVIOUS` | No          | —                                                  | Prior operator secret during key rotation.                                            |
| `LOOP_STELLAR_USDC_ISSUER`              | Yes (prod)  | —                                                  | Circle USDC issuer G-account.                                                         |
| `LOOP_STELLAR_USDLOOP_ISSUER`           | Yes (prod)  | —                                                  | USDLOOP issuer (ADR 015).                                                             |
| `LOOP_STELLAR_GBPLOOP_ISSUER`           | Yes (prod)  | —                                                  | GBPLOOP issuer.                                                                       |
| `LOOP_STELLAR_EURLOOP_ISSUER`           | Yes (prod)  | —                                                  | EURLOOP issuer.                                                                       |
| `LOOP_STELLAR_USDC_FLOOR_STROOPS`       | Recommended | —                                                  | Alert floor on the USDC operator balance; below this triggers `notifyUsdcBelowFloor`. |
| `LOOP_STELLAR_NETWORK_PASSPHRASE`       | No          | `"Public Global Stellar Network ; September 2015"` | Mainnet passphrase; override for testnet.                                             |
| `LOOP_STELLAR_HORIZON_URL`              | No          | `https://horizon.stellar.org`                      | Horizon base URL (A2-1513).                                                           |
| `LOOP_XLM_PRICE_FEED_URL`               | No          | —                                                  | Override XLM price feed (A2-1812).                                                    |
| `LOOP_FX_FEED_URL`                      | No          | —                                                  | Override FX price feed (A2-1812).                                                     |
| `LOOP_ASSET_DRIFT_THRESHOLD_STROOPS`    | No          | schema default                                     | Drift watcher alert threshold.                                                        |

#### CTX operator pool (ADR 013)

| Variable            | Required | Default | Description                                                                                                                             |
| ------------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `CTX_OPERATOR_POOL` | No       | `''`    | JSON-encoded `[{ id, bearer }]` array for the principal-switch operator pool (A2-1812). Unset → pool is inert (legacy proxy path only). |

#### Background workers

| Variable                                    | Required | Default          | Description                                                                                                                        |
| ------------------------------------------- | -------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `LOOP_WORKERS_ENABLED`                      | No       | `false`          | Master switch for all outbound workers. Set `true` on prod + Fly staging once Stellar secrets are wired.                           |
| `LOOP_PAYOUT_WORKER_INTERVAL_SECONDS`       | No       | `30`             | Payout worker tick cadence.                                                                                                        |
| `LOOP_PAYOUT_MAX_ATTEMPTS`                  | No       | schema default   | Retries before a payout transitions to `failed`.                                                                                   |
| `LOOP_PAYOUT_WATCHDOG_STALE_SECONDS`        | No       | schema default   | `submitted` payouts older than this get re-picked (A2-602).                                                                        |
| `LOOP_PAYOUT_FEE_BASE_STROOPS`              | No       | `100`            | A2-1921: Stellar fee for a payout's first submit attempt.                                                                          |
| `LOOP_PAYOUT_FEE_MULTIPLIER`                | No       | `2`              | A2-1921: per-attempt fee scaling factor (attempt N pays `BASE * MULTIPLIER^(N-1)`).                                                |
| `LOOP_PAYOUT_FEE_CAP_STROOPS`               | No       | `100000`         | A2-1921: ceiling on the scaled fee.                                                                                                |
| `LOOP_PAYMENT_WATCHER_INTERVAL_SECONDS`     | No       | schema default   | Horizon payment watcher cadence.                                                                                                   |
| `LOOP_PROCUREMENT_INTERVAL_SECONDS`         | No       | schema default   | CTX procurement worker cadence.                                                                                                    |
| `LOOP_ASSET_DRIFT_WATCHER_INTERVAL_SECONDS` | No       | schema default   | Asset drift watcher cadence.                                                                                                       |
| `INTEREST_APY_BASIS_POINTS`                 | No       | schema default   | APY for the interest-accrual primitive.                                                                                            |
| `INTEREST_PERIODS_PER_YEAR`                 | No       | schema default   | E.g. `365` for daily, `12` for monthly.                                                                                            |
| `INTEREST_TICK_INTERVAL_HOURS`              | No       | schema default   | Wall-clock cadence of the interest scheduler.                                                                                      |
| `LOOP_INTEREST_POOL_ACCOUNT`                | No       | operator account | ADR 009/015: forward-mint pool account the daily interest accrual sub-allocates from. Defaults to the operator account when unset. |
| `LOOP_INTEREST_POOL_MIN_DAYS_COVER`         | No       | `7`              | Pool watcher pages Discord monitoring when the on-chain pool covers fewer than this many days of forecast interest.                |

#### Runtime kill switches (A2-1907)

Set any of these to `true` on a running deployment (`fly secrets set LOOP_KILL_<NAME>=true -a loopfinance-api` — triggers a rolling restart) and the matching surface returns `503 SUBSYSTEM_DISABLED` without a redeploy. All default `false`. Operator runbook: `docs/runbooks/kill-switch.md`.

| Variable                  | Required | Default | Description                                                                                               |
| ------------------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `LOOP_KILL_ORDERS`        | No       | `false` | Gates `POST /api/orders` + `POST /api/orders/loop` (combined).                                            |
| `LOOP_KILL_ORDERS_LEGACY` | No       | unset   | Gates `POST /api/orders` only. Set → overrides `LOOP_KILL_ORDERS` for that path; unset → falls back.      |
| `LOOP_KILL_ORDERS_LOOP`   | No       | unset   | Gates `POST /api/orders/loop` only. Set → overrides `LOOP_KILL_ORDERS` for that path; unset → falls back. |
| `LOOP_KILL_AUTH`          | No       | `false` | Gates request-otp / verify-otp / social logins. Refresh + logout stay open so existing sessions drain.    |
| `LOOP_KILL_WITHDRAWALS`   | No       | `false` | Gates the admin withdrawal + compensation endpoints.                                                      |

`env.ts` is the source of truth; run `parseEnv()` via `npm run dev -w @loop/backend` locally to validate a deploy's env block before pushing.

### Subsequent deploys

```bash
# A2-410: deploy from repo root so the docker build context covers
# packages/shared/ and the workspace lockfile. `--config` + `--dockerfile`
# pin the apps/backend artifacts while leaving the context = cwd.
fly deploy --config apps/backend/fly.toml --dockerfile apps/backend/Dockerfile
```

#### GeoLite2 (region selector first-guess, ADR 033)

`GET /api/public/geo` reads a MaxMind **GeoLite2-Country** `.mmdb` baked into the
image at build time (the Dockerfile downloads it via build secrets — best-effort, so
a build without the secrets just falls back to the US default). To provision it,
deploy with the MaxMind account ID + license key as build secrets:

```bash
fly deploy --config apps/backend/fly.toml --dockerfile apps/backend/Dockerfile \
  --build-secret maxmind_account_id="$MAXMIND_ACCOUNT_ID" \
  --build-secret maxmind_license_key="$MAXMIND_LICENSE_KEY"
```

The DB refreshes on each such deploy. `MAXMIND_GEOLITE2_PATH` is set in the Dockerfile
(`/app/geoip/GeoLite2-Country.mmdb`); no `fly secrets` entry is needed since the build
secrets are consumed at build time, not runtime.

### Scaling

```bash
fly scale count 2 --region iad    # 2 machines in US
fly scale count 2 --region lhr    # 2 machines in EU
fly scale vm shared-cpu-2x        # Upgrade CPU if needed
```

### Monitoring

```bash
fly status                    # Machine status
fly logs                      # Live logs
fly ssh console               # SSH into machine
curl https://loopfinance-api.fly.dev/health  # Health check
```

### Ledger invariant smoke (A2-1519)

Every ledger-mutating path (cashback capture, interest accrual, admin
adjustment, refund) maintains the ADR-009 invariant
`user_credits.balance_minor == SUM(credit_transactions.amount_minor)`
per `(user_id, currency)` pair. To smoke-test after a deploy that
touched any of those paths, from a machine with `DATABASE_URL` set:

```bash
fly ssh console -a loopfinance-api
# inside the machine:
DATABASE_URL=$DATABASE_URL node --loader tsx dist/scripts/check-ledger-invariant.js
# or from a local env pointed at prod read-replica:
DATABASE_URL=postgres://... npm --workspace=@loop/backend run check:ledger
```

Exit codes: `0` consistent, `1` drift (rows printed to stdout), `2` DB
error. The live admin surface `GET /api/admin/reconciliation` runs the
same query — `src/credits/ledger-invariant.ts::computeLedgerDriftSql`
is the single source of truth. Synthetic drift scenarios are covered by
`src/credits/__tests__/ledger-invariant.test.ts`.

---

## Web (SSR) — Fly.io

### First-time setup

```bash
# Deploy from repo root — same rationale as the backend (audit A2-410):
# apps/web/Dockerfile copies from packages/shared/ + the workspace lockfile,
# so the docker build context has to be the repo root.
fly launch --name loopfinance-web --region iad --no-deploy --config apps/web/fly.toml --dockerfile apps/web/Dockerfile

# Add EU region
fly regions add lhr --config apps/web/fly.toml

# Deploy
fly deploy --config apps/web/fly.toml --dockerfile apps/web/Dockerfile
```

### Configuration

See `apps/web/fly.toml`:

- Primary region: `iad`
- VM: 256MB shared-cpu (SSR is lightweight)
- `VITE_API_URL` baked in at build time (set in fly.toml build args)
- Health check: `GET /` every 15s, 30s grace period (PR #150)
- Force HTTPS

### Environment variables — build-time only (A4-072 gotcha)

The web app has **no runtime env**: Vite freezes every
`import.meta.env.VITE_*` value into the bundle when the static assets
are emitted. Anything the bundle reads must be supplied as a **docker
build arg**, not a Fly runtime secret:

- `VITE_API_URL` — defaults to `https://api.loopfinance.io` in
  `apps/web/fly.toml` `[build.args]`.
- `VITE_SENTRY_DSN` / `VITE_SENTRY_RELEASE` / `VITE_LOOP_ENV` —
  default **empty**, which means **Sentry silently stays off**: the
  `Sentry.init` call at `root.tsx` is gated on `VITE_SENTRY_DSN`, so a
  deploy that forgets the build arg produces a working bundle whose
  frontend errors are invisible to ops. Production deploys MUST pass
  them, either via `fly secrets set VITE_SENTRY_DSN=…` (Fly overlays
  secrets onto build args) or explicitly:

  ```bash
  fly deploy --config apps/web/fly.toml --dockerfile apps/web/Dockerfile \
    --build-arg VITE_SENTRY_DSN=https://...@sentry.io/... \
    --build-arg VITE_SENTRY_RELEASE=$(git rev-parse HEAD) \
    --build-arg VITE_LOOP_ENV=production
  ```

  Setting a runtime secret on the running app does nothing — the
  value has to be present **at image build time**.

Note this Fly app serves the **SSR** build (`npm run build` →
`ssr: true`) only. The `BUILD_TARGET=mobile` static export
(`npm run build:mobile`) is never deployed to Fly — it is bundled into
the Capacitor binary (§Mobile below) and has no server-side loaders at
all (`docs/architecture.md` §Web build modes).

### Subsequent deploys

```bash
# A2-410: deploy from repo root, same rationale as the backend.
fly deploy --config apps/web/fly.toml --dockerfile apps/web/Dockerfile
```

---

## DNS

Point these domains to Fly.io:

```
api.loopfinance.io  → CNAME loopfinance-api.fly.dev
loopfinance.io      → CNAME loopfinance-web.fly.dev
www.loopfinance.io  → CNAME loopfinance-web.fly.dev
```

Fly.io handles TLS certificates automatically via Let's Encrypt.

```bash
# Register custom domains with Fly. `--config` selects the right
# fly.toml from repo root — A2-410 unified deploy posture.
fly certs add api.loopfinance.io --config apps/backend/fly.toml
fly certs add loopfinance.io --config apps/web/fly.toml
fly certs add www.loopfinance.io --config apps/web/fly.toml
```

---

## CI secrets (GitHub Actions)

These are **repo-level** GitHub secrets/vars — they configure CI workflows, not the running backend, so they don't appear in `env.ts` or `.env.example`. Provision via `gh secret set <NAME>` (or `gh variable set` where noted). Missing entries degrade gracefully (skipped steps / silent notifications), which makes them easy to forget on a fresh fork — this list is the checklist.

| Secret / var                  | Kind     | Used by                                  | Effect when missing                                                                                                                                                                 |
| ----------------------------- | -------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_WEBHOOK_DEPLOYMENTS` | secret   | `ci.yml` notify job                      | No CI pass/fail messages in Discord `#loop-deployments`. Also listed as RECOMMENDED in `scripts/preflight-tranche-1.sh`.                                                            |
| `SENTRY_AUTH_TOKEN`           | secret   | `ci.yml` build job (source-map upload)   | Source-map upload to Sentry is skipped (A2-1307). Push builds only.                                                                                                                 |
| `SENTRY_ORG`                  | variable | `ci.yml` build job                       | Source-map upload step warns and skips.                                                                                                                                             |
| `SENTRY_PROJECT`              | variable | `ci.yml` build job                       | Source-map upload step warns and skips.                                                                                                                                             |
| `LOOP_E2E_REFRESH_TOKEN`      | secret   | `e2e-real.yml` (real Tranche-1 purchase) | Real-upstream e2e fails at auth. Bootstrap + rotate via `scripts/bootstrap-e2e-refresh-token.sh` (CTX rotates the refresh token on every use; the workflow re-uploads the new one). |
| `STELLAR_TEST_SECRET_KEY`     | secret   | `e2e-real.yml`                           | Real-upstream e2e cannot pay the order. Mainnet test wallet secret — fund with a few XLM; treat as production-adjacent (it holds real funds).                                       |

---

## Mobile — App Store / Play Store

### Prerequisites

1. Build web static export:

   ```bash
   cd apps/web && npm run build:mobile
   ```

2. Sync to native projects, then re-apply the overlays so audit
   A-033 (Android backup rules) and A-034
   (`NSFaceIDUsageDescription`) survive the regeneration:
   ```bash
   cd apps/mobile && npm run sync
   ```
   The overlay script is idempotent and is now part of the sync script,
   so the hardened native config reapplies on every standard sync.

### iOS (App Store)

```bash
cd apps/mobile && npx cap open ios
```

In Xcode:

- Select team and bundle ID `io.loopfinance.app`
- Product → Archive → Distribute App → App Store Connect

### Android (Google Play)

```bash
cd apps/mobile && npx cap open android
```

In Android Studio:

- Build → Generate Signed Bundle / APK
- Upload `.aab` to Play Console

**Release-signing wiring.** `apply-native-overlays.sh` copies a
`signing.gradle` overlay into the regenerated Android tree on every
`cap sync` and patches `app/build.gradle` to `apply from:
'signing.gradle'`. The signing script reads
`apps/mobile/android/keystore.properties` (gitignored — copy
`keystore.properties.example` to seed) and injects
`signingConfigs.release` referenced by the `release` build type. If
`keystore.properties` is absent, Gradle logs a warning and the
release variant builds unsigned — fine for local smoke, not
shippable. Keystore generation steps live in
`docs/tranche-1-launch.md` §"Track 4 — Android signed APK".

### Signing / provisioning / cert-expiry runbook (A2-1205)

Apple and Google credentials expire on different cycles, and a missed
renewal blocks every release until the new artifact is in place. Track
each item below; the calendar lives in 1Password under `Loop · Mobile
signing`.

| Asset                                                          | Lifetime            | Where it lives                                     | Renewal trigger                                                                                                                                                                                                                                          |
| -------------------------------------------------------------- | ------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apple Developer Program membership                             | **1 year**          | Apple Developer account                            | 30-day reminder before lapse — without it, Push, In-App Purchase, and TestFlight stop.                                                                                                                                                                   |
| iOS Distribution Certificate                                   | **1 year**          | Apple Developer → Certificates                     | 30-day reminder. Re-issue, re-download, install in Xcode keychain, archive a smoke build.                                                                                                                                                                |
| App Store Connect API Key (`AuthKey_*.p8`)                     | No expiry           | 1Password (download once)                          | Rotate manually if compromised. Used by `xcodebuild` upload + Fastlane match if adopted.                                                                                                                                                                 |
| iOS Provisioning Profile (App Store)                           | **1 year**          | Apple Developer → Profiles                         | Auto-renews via Xcode "Automatically manage signing" once cert is current.                                                                                                                                                                               |
| iOS Push (APNs) Auth Key                                       | No expiry           | 1Password                                          | Rotate manually if compromised; one key per team.                                                                                                                                                                                                        |
| Google Play upload key (`upload-keystore.jks`)                 | **25 years** at gen | 1Password (sealed) + offline cold backup           | Never — losing it requires Play Support reset.                                                                                                                                                                                                           |
| Google Play app signing key (Play-managed)                     | Managed by Google   | Google Play Console                                | Never — Google holds it.                                                                                                                                                                                                                                 |
| FCM Server Key / Service-account JSON                          | No expiry           | 1Password                                          | Rotate manually if compromised; document new key in `apps/backend/.env`.                                                                                                                                                                                 |
| Android Studio CMake / NDK toolchain                           | Tied to AGP         | Local install                                      | Bump alongside `apps/mobile/android/build.gradle` AGP upgrades.                                                                                                                                                                                          |
| Apple `NSFaceIDUsageDescription` overlay (A-034)               | n/a                 | `apps/mobile/native-overlays/ios/...`              | Re-applies on every `cap sync` via `apply-native-overlays.sh`. CI flag if missing.                                                                                                                                                                       |
| iOS `release.xcconfig` overlay (A2-1201)                       | n/a                 | `apps/mobile/native-overlays/ios/release.xcconfig` | Re-copied on every `cap sync`. **Operator-once after `cap add ios`:** Xcode → App target → Build Settings → Configurations → Release → set baseConfigurationReference to `release.xcconfig`. Pins `CAPACITOR_DEBUG = false` for App-Store-signed builds. |
| Android backup-rules + FileProvider overlays (A-033 / A2-1213) | n/a                 | `apps/mobile/native-overlays/android/...`          | Re-applies on every `cap sync`; see overlay script's pre-flight checks.                                                                                                                                                                                  |

**Expiry calendar.** Add the cert + provisioning expiry dates to the
team's shared calendar with 30-day and 7-day reminders. Both maintainers
get the alerts. The 30-day window is the renewal-action signal; the
7-day window is the "this is about to ship-block us" escalation.

**Version-bump discipline (A2-1203).** TestFlight and Play Console both
**reject any build whose version code is not strictly higher than the
previously-uploaded artifact**, regardless of build path. Loop's policy:

- iOS `CFBundleVersion` (build number) is the **CI run number** — set by the
  release workflow before `xcodebuild archive`. Never hand-edit.
- iOS `CFBundleShortVersionString` (marketing version) is the public
  semver, edited by the release author.
- Android `versionCode` is the **CI run number** (matches iOS so the two
  binaries are easy to correlate). Never hand-edit.
- Android `versionName` is the public semver, edited by the release
  author alongside the iOS `CFBundleShortVersionString`.
- A new release ships only after both stores accept the upload — if one
  fails, the other gets pulled before users see version skew.

---

## Docker (local testing)

```bash
# Build images
docker build -t loopfinance-api -f apps/backend/Dockerfile .
docker build -t loopfinance-web -f apps/web/Dockerfile .

# Run backend — the Dockerfile hardcodes NODE_ENV=production, so the
# audit A-025 allowlist is required; either set IMAGE_PROXY_ALLOWED_HOSTS
# (preferred) or set DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT=1 to skip
# the production boot check for quick local tests.
docker run -p 8080:8080 \
  -e GIFT_CARD_API_BASE_URL=https://spend.ctx.com \
  -e IMAGE_PROXY_ALLOWED_HOSTS=spend.ctx.com,ctx-spend.s3.us-west-2.amazonaws.com \
  -e TRUST_PROXY=false \
  loopfinance-api

# Run web
docker run -p 3000:3000 loopfinance-web
```

---

## Graceful shutdown

The backend handles SIGTERM/SIGINT:

1. Stops accepting new connections
2. Drains in-flight requests (up to 10s)
3. Exits cleanly

Fly.io sends SIGTERM on deploy, giving the process time to drain before force-killing.

---

## Startup sequence

1. Backend starts, begins listening on port immediately
2. Merchants sync from CTX (~1s) — lightweight, loads first
3. Locations sync starts 3s later (~3 min for 116K locations)
4. During location loading: health reports `locationsLoading: true`, map shows no markers
5. After loading: full data available, health reports `locationsLoading: false`

Rolling deploys ensure at least one instance has full data at all times.
