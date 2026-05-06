# Phase-1 backend redeploy audit (deployed 2026-04-20 → main)

The currently-deployed `loopfinance-api` binary on Fly was deployed
2026-04-20 against commit `1643902c`. This document captures
**everything that has changed since then** that the operator needs to
know before running `flyctl deploy` on the Tranche-1 redeploy.

Findings come from two sources: a git diff `1643902c..HEAD` and a
local boot test against the current main with full Tranche-1 env on
2026-05-06. The boot test surfaced one gate the diff alone wouldn't
have caught.

## TL;DR — operator action items

1. **Set `DATABASE_URL`** on Fly before deploy. The deployed binary
   doesn't have one (the env schema didn't require it back then). The
   current binary refuses to boot without one. Use the Fly Postgres
   app's connection string, or attach a fresh Postgres app.
2. **Set `EMAIL_PROVIDER=resend`** (NOT `console`) — the boot test
   discovered the backend hard-refuses to start in
   `NODE_ENV=production` with `LOOP_AUTH_NATIVE_ENABLED=true` and
   `EMAIL_PROVIDER` unset or `=console`. The error message is loud
   ("Refusing to boot") so this won't silently break, but it will
   block the deploy.
3. **Verify `LOOP_STELLAR_DEPOSIT_ADDRESS` exists on mainnet Horizon**
   before deploy. If the address isn't a real funded account the
   `payment_watcher` will 400 every tick and `/health` reports
   `degraded` permanently — visible in `/health`'s `workers[].lastError`,
   but only after deploy. Cheap pre-check:
   `curl https://horizon.stellar.org/accounts/<G…>` should 200.
4. **Brace for 33 SQL migrations** to apply on first deploy. The
   release_command in `apps/backend/fly.toml` runs migrate-cli.js
   ahead of traffic — a failed migration aborts the deploy without
   serving traffic from the new binary, so this is safe (the old
   machines keep serving). But if the migration set fails midway, the
   release machine surfaces the error in Fly logs and you'll need to
   diagnose before redeploying.

If `./scripts/preflight-tranche-1.sh` reports clean and the four
items above check out, the redeploy is unblocked.

---

## Boot-time gates added since deploy

The current binary has these hard requirements that the deployed
binary did not. All come from `apps/backend/src/env.ts` or its
`parseEnv` post-validation block:

| Gate                                                  | Triggered by                                              | Failure mode                                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` (postgres URL)                         | Always — schema requires it                               | Backend won't boot                                                                                |
| `LOOP_JWT_SIGNING_KEY` (≥32 chars)                    | `LOOP_AUTH_NATIVE_ENABLED=true`                           | Refuses to boot                                                                                   |
| `LOOP_STELLAR_DEPOSIT_ADDRESS` (Stellar pubkey shape) | `LOOP_AUTH_NATIVE_ENABLED=true`                           | Refuses to boot                                                                                   |
| `LOOP_STELLAR_OPERATOR_SECRET` (Stellar secret shape) | `LOOP_WORKERS_ENABLED=true`                               | Refuses to boot                                                                                   |
| `LOOP_STELLAR_USDC_ISSUER` (Stellar pubkey)           | USDC support                                              | Refuses to boot if USDC enabled                                                                   |
| `EMAIL_PROVIDER=resend`                               | `LOOP_AUTH_NATIVE_ENABLED=true` AND `NODE_ENV=production` | "Refusing to boot — no real provider implemented"                                                 |
| `RESEND_API_KEY`                                      | `EMAIL_PROVIDER=resend`                                   | Boot succeeds; first OTP send fails — operator only notices when a user reports they got no email |
| `IMAGE_PROXY_ALLOWED_HOSTS`                           | `NODE_ENV=production`                                     | Refuses to boot                                                                                   |
| `DISABLE_RATE_LIMITING=false`                         | `NODE_ENV=production`                                     | Refuses to boot if true                                                                           |

`./scripts/preflight-tranche-1.sh` covers everything in this table
that lives as a Fly secret. `EMAIL_PROVIDER` and the four
`LOOP_AUTH_NATIVE_ENABLED` / `LOOP_WORKERS_ENABLED` / `LOOP_PHASE_1_ONLY`
booleans typically ride in `fly.toml [env]` and need verification
there.

---

## Database migrations to apply

33 SQL migrations under `apps/backend/src/db/migrations/0000…0032`
will run on first deploy via the `release_command` in
`apps/backend/fly.toml` (`node apps/backend/dist/migrate-cli.js`).
Highlights of what they create:

- `0000` — initial schema (users, merchants, orders, etc).
- `0001` — auth tables (otps, refresh_tokens).
- `0002` — `loop_orders` (the Tranche-1 / ADR 010 principal-switch path).
- `0005` — `user_identities` (Google + Apple social login, ADR 014).
- `0010` — `pending_payouts` (ADR 016 Stellar payout queue).
- `0013` — ledger CHECK constraints (negative-balance + currency-mismatch guards).
- `0023` — `orders.idempotency_key` UNIQUE (prevents double-creates from retries).
- `0029` — cashback_config audit triggers (admin write attribution).

The full list is in `apps/backend/src/db/migrations/`. Drizzle's
migrator is idempotent on already-applied migrations, so a re-run
after partial application is safe.

If the deploy's release-command machine reports a migration failure,
common causes:

- **postgres permission insufficient** — the connection user must
  have `CREATE` on the schema, not just SELECT/INSERT.
- **older postgres version** — check requires postgres 14+ for some
  features (CHECK constraint syntax, generated columns).
- **existing schema collision** — the deployed binary doesn't write
  to postgres (it has no `DATABASE_URL`), so the database is
  presumably empty. If the operator points at a postgres that already
  has Loop tables from a different environment, drop them first.

---

## Worker behavior change

The current binary boots three required workers when
`LOOP_WORKERS_ENABLED=true`:

- `payment_watcher` — polls Horizon for incoming deposits to
  `LOOP_STELLAR_DEPOSIT_ADDRESS` every 10s.
- `procurement_worker` — picks up paid orders, calls CTX
  `/gift-cards` to procure them, every 5s.
- `payout_worker` — drains `pending_payouts` to user wallets every
  30s. Tranche-1 doesn't enqueue payouts (LOOP_PHASE_1_ONLY=true
  means cashback is delivered as instant discount), so this worker
  runs idle. It's still required to exist by the health check.

Two optional workers are inert in Tranche-1:

- `asset_drift_watcher` — gated on LOOP-asset issuer envs being set.
  Tranche-1 leaves them unset, watcher reports
  `running:false, blockedReason:"no LOOP issuers configured"`.
- `interest_scheduler` — gated on `INTEREST_APY_BASIS_POINTS > 0`.
  Tranche-1 leaves it at the default 0, scheduler reports
  `running:false, blockedReason:"interest APY is zero"`.

Local boot test confirmed all five workers report correct state
under the Tranche-1 env. `payment_watcher` will degrade if
`LOOP_STELLAR_DEPOSIT_ADDRESS` doesn't exist on mainnet — see TL;DR
item 3.

---

## Endpoint surface added

Selected new endpoints the deployed binary doesn't have. Mobile +
web clients targeting the new binary will start using these
immediately on redeploy:

- `GET /api/config` — runtime config flags (`loopAuthNativeEnabled`,
  `loopOrdersEnabled`, `phase1Only`, social-login client IDs, LOOP
  asset availability). Web client reads on every page load.
- `POST /api/orders/loop` — Tranche-1 order create.
- `GET /api/orders/loop` + `GET /api/orders/loop/:id` — Tranche-1 order list / detail.
- `POST /api/auth/social/google` + `/apple` — social login (ADR 014).
- `GET /api/users/me/*` — user profile + favourites + recently-purchased.
- `GET /api/admin/*` — extensive admin panel surface (treasury, payouts, credit adjustments, audit log, CSV exports).
- `GET /metrics` + `GET /openapi.json` — bearer-gated in production.

Total commits to `apps/backend/src` since deploy: **533**.

- 187 features
- 87 fixes
- 162 refactors
- 18 tests
- 13 docs
- 57 other (build / chore)

---

## What stayed the same

- `GIFT_CARD_API_BASE_URL=https://spend.ctx.com` — same upstream.
- `GIFT_CARD_API_KEY` + `GIFT_CARD_API_SECRET` — same /locations
  credentials, already set on the deployed app's Fly secrets. No
  action needed.
- `IMAGE_PROXY_ALLOWED_HOSTS` — same allowlist, already in
  `fly.toml [env]`. No action needed.
- `TRUST_PROXY=true` — same Fly-edge posture.
- The legacy CTX-proxy `POST /api/orders` endpoint — still present
  for back-compat with old clients. Tranche-1+ traffic routes
  through `/api/orders/loop`; the legacy endpoint stays available
  but unused by current builds.

---

## Local boot-test record

Run on 2026-05-06 against `main` HEAD (post-#1337) on a fresh
docker-postgres + `NODE_ENV=production`. Result: backend booted
cleanly, all workers transitioned to `running:true`, `/api/config`
returned the expected Tranche-1 surface (`loopAuthNativeEnabled:
true, loopOrdersEnabled:true, phase1Only:true`),
`POST /api/orders/loop` returned 401 without auth, 328 merchants
synced from real CTX.

`/health` reported `degraded` for two reasons (both expected with a
test deposit address + missing CTX_API creds):

- `payment_watcher` 400ing on a synthetic deposit address.
- `locations_stale` because `GIFT_CARD_API_KEY/SECRET` were not set
  for /locations.

Neither happens on the real Fly redeploy — both env values are
already present in production secrets / will be when the operator
sets them.
