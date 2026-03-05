# Deployment

## Backend — Fly.io (recommended) or Docker

### Docker

Create `apps/backend/Dockerfile`:

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY apps/backend/package*.json apps/backend/
COPY packages/shared/package*.json packages/shared/
RUN npm ci
COPY . .
RUN npm run build -w @loop/backend

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/apps/backend/dist ./dist
COPY --from=builder /app/apps/backend/package.json .
COPY --from=builder /app/packages/shared ./packages/shared
RUN npm ci --omit=dev
CMD ["node", "dist/index.js"]
```

```bash
# Build and run locally
docker build -t loop-backend -f apps/backend/Dockerfile .
docker run -p 8080:8080 --env-file apps/backend/.env loop-backend
```

### Fly.io

```bash
cd apps/backend

# First-time setup
fly launch --name loop-backend --region lhr

# Set secrets (do not commit .env)
fly secrets set \
  JWT_SECRET=... \
  JWT_REFRESH_SECRET=... \
  GIFT_CARD_API_BASE_URL=... \
  GIFT_CARD_API_KEY=... \
  GIFT_CARD_API_SECRET=... \
  SMTP_HOST=... \
  SMTP_PORT=587 \
  SMTP_USER=... \
  SMTP_PASS=... \
  EMAIL_FROM=noreply@loop.app

# Deploy
fly deploy
```

`fly.toml` (create in `apps/backend/`):
```toml
app = "loop-backend"
primary_region = "lhr"

[build]

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 1

[[vm]]
  memory = "512mb"
  cpu_kind = "shared"
  cpus = 1
```

Health check: `GET /health` → `200 { status: "healthy", ... }`

---

## Web (SSR) — Fly.io or Vercel

### Fly.io

```bash
cd apps/web

# Build
npm run build

# Fly config — create apps/web/fly.toml
fly launch --name loop-web --region lhr
fly deploy
```

`fly.toml` for web:
```toml
app = "loop-web"
primary_region = "lhr"

[build]
  dockerfile = "Dockerfile"

[env]
  VITE_API_URL = "https://loop-backend.fly.dev"

[http_service]
  internal_port = 3000
  force_https = true
```

`apps/web/Dockerfile`:
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY apps/web/package*.json apps/web/
COPY packages/shared/package*.json packages/shared/
RUN npm ci
COPY . .
RUN npm run build -w @loop/web

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/apps/web/build ./build
COPY --from=builder /app/apps/web/package.json .
RUN npm ci --omit=dev
CMD ["node", "./build/server/index.js"]
```

### Vercel

```bash
# In Vercel dashboard:
# Framework: React Router / Vite (or Other)
# Root directory: apps/web
# Build command: npm run build
# Output directory: build/client (for assets) — Vercel auto-detects SSR

# Environment variables in Vercel dashboard:
VITE_API_URL=https://api.loop.app
```

---

## Mobile — App Store / Play Store

### Prerequisites

1. Build web static export:
   ```bash
   cd apps/web && npm run build:mobile
   ```

2. Sync to native projects:
   ```bash
   cd apps/mobile && npx cap sync
   ```

### iOS (App Store)

```bash
cd apps/mobile
npx cap open ios          # Opens Xcode
```

In Xcode:
- Select team and bundle ID `io.loopfinance.app`
- Product → Archive
- Distribute App → App Store Connect
- Upload

### Android (Google Play)

```bash
cd apps/mobile
npx cap open android      # Opens Android Studio
```

In Android Studio:
- Build → Generate Signed Bundle / APK
- Upload `.aab` to Play Console

### Version bumping

Before each release, update `version` in `apps/mobile/package.json` and corresponding native project files (`Info.plist` / `build.gradle`).

---

## CI/CD

GitHub Actions handles automated deployment on merge to `main`. See `.github/workflows/ci.yml`.

Deployment is **not** automated from CI — deployments are manual (`fly deploy` / Xcode Archive) until deployment pipelines are established.

---

## Secrets management

| Secret | Where stored |
|--------|-------------|
| Backend env vars | Fly.io secrets (`fly secrets set`) |
| Web env vars | Vercel environment variables |
| Apple certificates | Keychain / Xcode managed |
| Google keystore | Android Studio / Play Console |
| Git repo secrets (for CI) | GitHub repository secrets |

Never commit `.env` files, `.p8` keys, `.p12` certificates, or keystore files.
