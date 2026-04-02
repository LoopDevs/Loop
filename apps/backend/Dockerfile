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

EXPOSE 8080
ENV PORT=8080 NODE_ENV=production

CMD ["node", "apps/backend/dist/index.js"]
