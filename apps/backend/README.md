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
npm run dev              # development (tsx watch — restarts on file change)
npm run build            # tsup → dist/ (bundles @loop/shared in; proto types split into a dynamic-import chunk)
npm start                # production (node dist/index.js)
npm test                 # vitest run
npm run test:watch       # vitest watch
npm run test:coverage    # vitest + coverage report
npm run typecheck        # tsc --noEmit
```

## Key modules

| Path                     | Purpose                                                                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`           | Entry point — bootstraps refreshes, serves the Hono app, wires graceful shutdown                                                                                                                                     |
| `src/app.ts`             | Hono app: middleware, route registration, error handler (tests import from here, never from `index.ts`)                                                                                                              |
| `src/clustering/`        | Grid-based map clustering algorithm + HTTP handler (protobuf / JSON negotiation)                                                                                                                                     |
| `src/merchants/`         | Upstream merchant sync + in-memory cache                                                                                                                                                                             |
| `src/auth/`              | **Proxy** to upstream CTX auth (request-OTP / verify / refresh / logout) + `requireAuth` middleware. The backend does not mint its own tokens — see the `AGENTS.md` auth rule and `docs/architecture.md` §Auth flow. |
| `src/images/`            | Image resize proxy using sharp, SSRF-validated, hostname-allowlisted                                                                                                                                                 |
| `src/orders/`            | Gift card order proxy to upstream (`POST /gift-cards` ↔ `POST /api/orders`)                                                                                                                                          |
| `src/circuit-breaker.ts` | Per-upstream-endpoint circuit breakers (ADR-004)                                                                                                                                                                     |
| `src/upstream.ts`        | Builds upstream URLs from `GIFT_CARD_API_BASE_URL` with path-traversal + CRLF-injection guards (defensive layer on top of per-handler validation)                                                                    |
| `src/discord.ts`         | Discord webhook senders for order created / fulfilled / health / circuit-breaker events. Fire-and-forget; never blocks app logic; `@everyone` suppression baked in                                                   |
| `src/openapi.ts`         | OpenAPI 3.1 spec generated from zod schemas. Served live at `GET /openapi.json`. Every new handler must register its path + status codes here — see `AGENTS.md` recipe step 8                                        |
| `src/logger.ts`          | Pino instance + `REDACT_PATHS` (its own test file locks the redaction list)                                                                                                                                          |
| `src/env.ts`             | Zod-validated env var schema — fails fast on startup                                                                                                                                                                 |

## Environment variables

See `.env.example` for all required variables with descriptions.

## API

See `docs/architecture.md#backend-api-endpoints` for the full endpoint list.
