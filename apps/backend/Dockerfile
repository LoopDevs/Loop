FROM node:22-alpine AS builder
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

# --- Production image ---
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/

# Install production deps only
RUN npm ci --omit=dev --ignore-scripts

# Copy bundled output (single file, no monorepo path issues)
COPY --from=builder /app/apps/backend/dist apps/backend/dist

# Run as the non-root `node` user that node:*-alpine ships with. The default
# is root — meaning any RCE in a dep would land with full container
# privileges. `node` has no write access outside its home, which is all this
# process needs. Chown the workdir so the user can still read the bundled
# dist + package.json it just lost the ability to modify.
RUN chown -R node:node /app
USER node

EXPOSE 8080
ENV PORT=8080 NODE_ENV=production

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

CMD ["node", "apps/backend/dist/index.js"]
