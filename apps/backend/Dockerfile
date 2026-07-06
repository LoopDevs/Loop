# A2-403: base image pinned by SHA256 digest, not just `22-alpine`.
# A floating tag lets a compromised upstream rewrite what our build
# actually uses; the digest is the one stable identity. Dependabot
# doesn't auto-bump digests — update deliberately: verify the new
# SHA against Docker Hub's signed manifest + Node's release notes
# before flipping.
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS builder
WORKDIR /app

# Copy workspace files
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/
COPY packages/shared/package.json packages/shared/

# Install all dependencies (need devDeps for build)
RUN npm ci --ignore-scripts && npm rebuild esbuild

# Copy source
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY apps/backend/ apps/backend/

# Build with tsup — bundles @loop/shared into single output
RUN npm run build -w @loop/backend

# Bake the MaxMind GeoLite2-Country DB for /api/public/geo's first guess (ADR 033).
# Best-effort + BuildKit-only: skipped when the build secrets are absent (CI/local image
# builds), so the endpoint just falls back to the US default. Done in the builder stage so
# curl never lands in the runtime image. Provide at deploy time:
#   flyctl deploy \
#     --build-secret maxmind_account_id=<account-id> \
#     --build-secret maxmind_license_key=<license-key>
RUN --mount=type=secret,id=maxmind_account_id \
    --mount=type=secret,id=maxmind_license_key \
    mkdir -p /app/geoip && \
    if [ -s /run/secrets/maxmind_license_key ]; then \
      apk add --no-cache curl && \
      curl -fsSL \
        -u "$(cat /run/secrets/maxmind_account_id):$(cat /run/secrets/maxmind_license_key)" \
        "https://download.maxmind.com/geoip/databases/GeoLite2-Country/download?suffix=tar.gz" \
        -o /tmp/geoip.tar.gz && \
      tar -xzf /tmp/geoip.tar.gz -C /tmp && \
      cp /tmp/GeoLite2-Country_*/GeoLite2-Country.mmdb /app/geoip/GeoLite2-Country.mmdb && \
      echo "GeoLite2-Country.mmdb baked: $(wc -c < /app/geoip/GeoLite2-Country.mmdb) bytes"; \
    else \
      echo "MaxMind build secrets absent — /api/public/geo will use the US default"; \
    fi

# --- Production image ---
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/

# Install production deps only
RUN npm ci --omit=dev --ignore-scripts

# Copy bundled output. A4-023: tsup `onSuccess` already copies
# `src/db/migrations` into `dist/migrations`, so the production
# image gets `_journal.json` + SQL files via this single COPY.
# Drizzle's migrator resolves `migrationsFolder` relative to the
# running script's directory (see db/client.ts `runMigrations`),
# so `dist/migrations` lands where the Fly `release_command`
# (`node apps/backend/dist/migrate-cli.js`) and boot-time
# `runMigrations()` look.
COPY --from=builder /app/apps/backend/dist apps/backend/dist

# GeoLite2-Country DB for /api/public/geo (ADR 033). Empty dir when not provisioned at
# deploy; MAXMIND_GEOLITE2_PATH (below) points at it and the handler degrades gracefully.
COPY --from=builder /app/geoip /app/geoip

# Run as the non-root `node` user that node:*-alpine ships with. The default
# is root — meaning any RCE in a dep would land with full container
# privileges. `node` has no write access outside its home, which is all this
# process needs. Chown the workdir so the user can still read the bundled
# dist + package.json it just lost the ability to modify.
RUN chown -R node:node /app
USER node

EXPOSE 8080
ENV PORT=8080 NODE_ENV=production MAXMIND_GEOLITE2_PATH=/app/geoip/GeoLite2-Country.mmdb

# A2-402: orchestrator-visible liveness probe. `GET /health` runs the
# app-level health logic (upstream reachability + DB + signing-key
# present) and always responds — 200 when green, 503 when degraded.
# Fly.io + Kubernetes read HEALTHCHECK status; a degraded container
# gets cycled instead of left serving traffic.
#
# Uses node's built-in http (no curl/wget dep on alpine). 5s timeout
# is well under the 30s interval so a hung process shows as unhealthy
# promptly. retries=3 keeps a transient upstream blip from cycling
# the pod.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# `--import ./instrument.js` runs Sentry's `init()` before any other
# module loads — required by @sentry/hono ≥ 10.51's split-init pattern
# so OpenTelemetry's auto-instrumentation can patch http/https first.
CMD ["node", "--import", "./apps/backend/dist/instrument.js", "apps/backend/dist/index.js"]
