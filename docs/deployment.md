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
     │  loop-web        │     │  loop-web         │
     └──────────────────┘     └──────────────────┘
```

Users hit the nearest region automatically via Fly.io anycast routing.
No shared state between regions — each instance fetches merchants/locations independently.

---

## Backend — Fly.io

### First-time setup

```bash
cd apps/backend
fly launch --name loopfinance-api --region iad --no-deploy

# Set secrets (API credentials for /locations endpoint only — the
# non-secret config like GIFT_CARD_API_BASE_URL, IMAGE_PROXY_ALLOWED_HOSTS,
# TRUST_PROXY, PORT, NODE_ENV, and LOG_LEVEL are baked into the
# apps/backend/fly.toml [env] block)
fly secrets set \
  GIFT_CARD_API_KEY=<key> \
  GIFT_CARD_API_SECRET=<secret>

# Add EU region
fly regions add lhr

# Deploy
fly deploy
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
| `REFRESH_INTERVAL_HOURS`          | No                 | `6`           | Merchant catalog refresh cadence                                                                                                                                                                                                                                                                                                            |
| `LOCATION_REFRESH_INTERVAL_HOURS` | No                 | `24`          | Location data refresh cadence                                                                                                                                                                                                                                                                                                               |
| `DISCORD_WEBHOOK_ORDERS`          | No                 | —             | Webhook URL for order created / fulfilled notifications                                                                                                                                                                                                                                                                                     |
| `DISCORD_WEBHOOK_MONITORING`      | No                 | —             | Webhook URL for health-status and circuit-breaker alerts                                                                                                                                                                                                                                                                                    |
| `SENTRY_DSN`                      | Recommended (prod) | —             | Backend error tracking DSN                                                                                                                                                                                                                                                                                                                  |
| `PORT`                            | No                 | `8080`        | Server port                                                                                                                                                                                                                                                                                                                                 |
| `NODE_ENV`                        | No                 | `development` | Environment. Schema default is `development`; prod deployments set it to `production` explicitly (our `fly.toml` + Dockerfile both do). Audit A-025's image-proxy allowlist enforcement and the `INCLUDE_DISABLED_MERCHANTS=true` boot warn only fire when `NODE_ENV === 'production'`, so leaving it unset in prod silently disables both. |
| `LOG_LEVEL`                       | No                 | `info`        | Pino log level (`trace`/`debug`/`info`/`warn`/`error`/`fatal`/`silent`)                                                                                                                                                                                                                                                                     |

### Subsequent deploys

```bash
cd apps/backend && fly deploy
```

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

---

## Web (SSR) — Fly.io

### First-time setup

```bash
cd apps/web
fly launch --name loop-web --region iad --no-deploy

# Add EU region
fly regions add lhr

# Deploy
fly deploy
```

### Configuration

See `apps/web/fly.toml`:

- Primary region: `iad`
- VM: 256MB shared-cpu (SSR is lightweight)
- `VITE_API_URL` baked in at build time (set in fly.toml build args)
- Health check: `GET /` every 15s, 30s grace period (PR #150)
- Force HTTPS

### Subsequent deploys

```bash
cd apps/web && fly deploy
```

---

## DNS

Point these domains to Fly.io:

```
api.loopfinance.io  → CNAME loopfinance-api.fly.dev
loopfinance.io      → CNAME loop-web.fly.dev
www.loopfinance.io  → CNAME loop-web.fly.dev
```

Fly.io handles TLS certificates automatically via Let's Encrypt.

```bash
# Register custom domains with Fly
cd apps/backend && fly certs add api.loopfinance.io
cd apps/web && fly certs add loopfinance.io && fly certs add www.loopfinance.io
```

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
   cd apps/mobile && npx cap sync && ./scripts/apply-native-overlays.sh
   ```
   The overlay script is idempotent — safe to run every time.

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

---

## Docker (local testing)

```bash
# Build images
docker build -t loopfinance-api -f apps/backend/Dockerfile .
docker build -t loop-web -f apps/web/Dockerfile .

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
docker run -p 3000:3000 loop-web
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
