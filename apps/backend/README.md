# @loop/backend

TypeScript API server built with [Hono](https://hono.dev/) on Node.js.

## Quickstart

```bash
cp .env.example .env      # fill in values
npm run dev               # tsx watch — restarts on file change
```

Server starts on `http://localhost:8080` (configurable via `PORT`).

## Commands

```bash
npm run dev              # development (hot reload)
npm run build            # tsc → dist/
npm start                # production (node dist/index.js)
npm test                 # vitest run
npm run test:watch       # vitest watch
npm run test:coverage    # vitest + coverage report
npm run typecheck        # tsc --noEmit
```

## Key modules

| Path              | Purpose                                              |
| ----------------- | ---------------------------------------------------- |
| `src/index.ts`    | Entry point, route registration, startup timers      |
| `src/clustering/` | Grid-based map clustering algorithm + HTTP handler   |
| `src/merchants/`  | Upstream merchant sync + in-memory cache             |
| `src/auth/`       | Email OTP, JWT issuance/validation, middleware       |
| `src/images/`     | Image resize proxy using sharp                       |
| `src/orders/`     | Gift card order proxy to upstream API                |
| `src/env.ts`      | Zod-validated env var schema — fails fast on startup |

## Environment variables

See `.env.example` for all required variables with descriptions.

## API

See `docs/architecture.md#backend-api-endpoints` for the full endpoint list.
