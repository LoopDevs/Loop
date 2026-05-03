FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS builder
WORKDIR /app

# Copy root workspace files
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

# Install all dependencies (need devDeps for build). Keep the hardened
# --ignore-scripts posture, then explicitly re-enable only esbuild's
# platform-binary selector — same supply-chain boundary as backend.
RUN npm ci --ignore-scripts && npm rebuild esbuild

# Copy source
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY apps/web/ apps/web/

# Build web (SSR)
#
# A4-072: every VITE_* the web bundle reads at runtime must be
# baked at BUILD time (Vite freezes `import.meta.env.VITE_*`
# values when the static assets are emitted). The production
# Sentry init at root.tsx:42 is gated on `VITE_SENTRY_DSN` —
# absent at build → undefined in the bundle → Sentry.init never
# fires → frontend errors invisible to ops. Plumb every Sentry-
# adjacent env through Dockerfile ARG + ENV, and mirror them in
# `apps/web/fly.toml` `[build.args]`. Defaults are empty so a
# local `docker build` without the args still produces a
# functional bundle (Sentry just stays off, same as before).
ARG VITE_API_URL=https://api.loopfinance.io
ENV VITE_API_URL=$VITE_API_URL
ARG VITE_SENTRY_DSN=
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN
ARG VITE_SENTRY_RELEASE=
ENV VITE_SENTRY_RELEASE=$VITE_SENTRY_RELEASE
ARG VITE_LOOP_ENV=
ENV VITE_LOOP_ENV=$VITE_LOOP_ENV
RUN npm run build -w @loop/web

# --- Production image ---
FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

RUN npm ci --omit=dev --ignore-scripts

# Copy built output
COPY --from=builder /app/apps/web/build apps/web/build
COPY --from=builder /app/packages/shared packages/shared

# Run as the non-root `node` user that node:*-alpine ships with. Same
# hardening as apps/backend/Dockerfile (PR #61). The default is root —
# meaning any RCE in a dep running under this image would land with
# full container privileges. `node` has no write access outside its
# home, which is all react-router-serve needs. Chown the workdir so
# the user can still read the bundled assets.
RUN chown -R node:node /app
USER node

EXPOSE 3000
ENV PORT=3000 NODE_ENV=production

WORKDIR /app/apps/web

# A2-402: liveness probe for Fly.io / Kubernetes. Hits the SSR root
# which always responds — react-router-serve serves the home route.
# 5s timeout; 3 retries keep a transient blip from cycling the pod.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 3000) + '/', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["npx", "react-router-serve", "./build/server/index.js"]
