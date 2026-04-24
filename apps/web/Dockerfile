FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS builder
WORKDIR /app

# Copy root workspace files
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

# Install all dependencies
# Use --ignore-scripts to skip husky, then run package postinstalls manually
RUN npm ci --ignore-scripts && npm rebuild

# Copy source
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY apps/web/ apps/web/

# Build web (SSR)
ARG VITE_API_URL=https://api.loopfinance.io
ENV VITE_API_URL=$VITE_API_URL
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
CMD ["npx", "react-router-serve", "./build/server/index.js"]
