# Deployed loopfinance-api snapshot — 2026-05-06

A point-in-time health + catalog snapshot of the currently-deployed
backend before the Tranche-1 redeploy. Useful as the "what state
were we in before" reference if anything is unexpectedly different
post-redeploy.

## Build identity

- **Fly app:** `loopfinance-api`
- **Latest deploy timestamp:** 2026-04-20 16:01:34 UTC
- **Deployed commit (estimated):** `1643902c` (last `apps/backend`
  change before the deploy timestamp)
- **Image:** `loopfinance-api:deployment-01KPNSYYKRV5PZS27NTZF9NYZB`
- **Region:** iad
- **Machines:** 2 (one started, one stopped — Fly's auto-stop
  behaviour with `min_machines_running=1`)

## /health response shape

```json
{
  "status": "healthy",
  "locationCount": 116219,
  "locationsLoading": false,
  "merchantCount": 328,
  "merchantsLoadedAt": "2026-05-06T10:02:10.285Z",
  "locationsLoadedAt": "2026-05-05T16:05:02.208Z",
  "merchantsStale": false,
  "locationsStale": false,
  "upstreamReachable": true
}
```

This is the **legacy `/health` shape** — pre-Tranche-1. After
redeploy, `/health` adds `databaseReachable`, `criticalDegraded`,
`softDegraded`, `softDegradedReasons`, `otpDelivery{}`, and a
`workers[]` array with per-worker run state. Mobile clients targeting
either shape parse it as JSON; no breaking change for the field
subset that overlaps.

## Catalog state

- **Total merchants:** 328
- **Enabled:** 328 / 328 (no disabled in cache)
- **By currency:**
  - USD: 128
  - GBP: 199
  - CAD: 1

The CAD merchant is an outlier — likely Canada Post or similar test
brand. Tranche-1 marketing focuses US/UK; CAD coverage is
nice-to-have but not gating.

### e2e-real test merchant — present and bookable

`Aerie` (id `a8f90501-c10a-4a14-adde-9a045b7ff1c6`):

- Currency: USD
- Min: $0.01 / Max: $500
- Savings: 2%
- Type: min-max (any cents-precision amount)

This is the merchant the `e2e-real` workflow defaults to. Min
denomination of $0.01 means the cheapest end-to-end test costs
1–2 cents per run.

### Locations

116,219 in-store locations cached, last refreshed 2026-05-05
16:05:02 UTC (~18 hours before this snapshot). `locationsStale=false`
— inside the 24 h refresh interval.

## Secrets currently set on Fly

5 of the 8 Tranche-1 required secrets are absent. Per
`./scripts/preflight-tranche-1.sh` against the live app, the gap is
exactly the Loop-native auth + payment surface:

```
✓ DISCORD_WEBHOOK_MONITORING
✓ DISCORD_WEBHOOK_ORDERS
✓ GIFT_CARD_API_KEY
✓ GIFT_CARD_API_SECRET
✓ SENTRY_DSN

✗ DATABASE_URL                  (MISSING — required at boot post-redeploy)
✗ LOOP_JWT_SIGNING_KEY          (MISSING)
✗ LOOP_STELLAR_DEPOSIT_ADDRESS  (MISSING)
✗ LOOP_STELLAR_OPERATOR_SECRET  (MISSING)
✗ LOOP_STELLAR_USDC_ISSUER      (MISSING)
✗ RESEND_API_KEY                (MISSING)
✗ METRICS_BEARER_TOKEN          (MISSING)
✗ OPENAPI_BEARER_TOKEN          (MISSING)
```

`DISCORD_WEBHOOK_ADMIN_AUDIT` and `DISCORD_WEBHOOK_DEPLOYMENTS` are
not yet set either — recommended but not boot-blocking.

## fly.toml [env] state

`apps/backend/fly.toml` currently sets:

```
PORT="8080"
NODE_ENV="production"
GIFT_CARD_API_BASE_URL="https://spend.ctx.com"
LOG_LEVEL="info"
IMAGE_PROXY_ALLOWED_HOSTS="spend.ctx.com,ctx-spend.s3.us-west-2.amazonaws.com"
TRUST_PROXY="true"
```

None of the Tranche-1 boolean flags or email config are set yet.
Per the redeploy audit (`docs/phase-1-redeploy-audit.md`), the
operator needs to add:

```
LOOP_PHASE_1_ONLY = "true"
LOOP_AUTH_NATIVE_ENABLED = "true"
LOOP_WORKERS_ENABLED = "true"
EMAIL_PROVIDER = "resend"        # boot refuses "console" in production
EMAIL_FROM_ADDRESS = "noreply@loopfinance.io"
EMAIL_FROM_NAME = "Loop"
LOOP_ENV = "production"
```

The new preflight script's VALUE_CHECKS layer will flag drift here
post-edit.

## Endpoints currently served

Verified on the legacy binary:

- `GET /health` — 200, legacy shape
- `GET /api/merchants/all` — 200, 328 merchants
- `GET /api/merchants` — 200, paginated (default 20)
- `GET /api/clusters` — 200 (location clustering)
- `POST /api/auth/request-otp` — proxies to CTX (no Loop-native
  auth on this build)
- `POST /api/orders` — legacy CTX-proxy order create (Tranche-1
  uses `/api/orders/loop` instead, which doesn't exist on this
  binary — verified: `/api/config` returns 404, an indirect signal
  the loop-native router isn't wired)

## Conclusion

Deployed backend is **healthy, current on catalog data, but
fundamentally pre-Tranche-1**. Nothing about the snapshot suggests
the redeploy is risky — there's no drift, the catalog is current,
the workers are doing what the legacy binary expects to do. The
redeploy is purely a forward-version step. The migration set
applies on a fresh DB (no `DATABASE_URL` on the deployed binary
means the postgres app has nothing in it yet).

If the operator runs `./scripts/preflight-tranche-1.sh` after
setting the secrets + fly.toml [env] additions and it reports PASS,
`flyctl deploy` should land cleanly.
