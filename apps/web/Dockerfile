FROM node:22-alpine AS builder
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
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

RUN npm ci --omit=dev --ignore-scripts

# Copy built output
COPY --from=builder /app/apps/web/build apps/web/build
COPY --from=builder /app/packages/shared packages/shared

EXPOSE 3000
ENV PORT=3000 NODE_ENV=production

WORKDIR /app/apps/web
CMD ["npx", "react-router-serve", "./build/server/index.js"]
