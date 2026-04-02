FROM node:22-alpine
WORKDIR /app

# Copy workspace files
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/
COPY packages/shared/package.json packages/shared/

# Install dependencies — skip husky prepare but rebuild native binaries
RUN npm ci --ignore-scripts && npm rebuild esbuild

# Copy source
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY apps/backend/ apps/backend/

EXPOSE 8080
ENV PORT=8080 NODE_ENV=production

# Use tsx to run TypeScript directly (same as dev, avoids monorepo path issues)
CMD ["npx", "tsx", "apps/backend/src/index.ts"]
