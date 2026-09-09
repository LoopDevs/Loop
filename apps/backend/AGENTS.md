# Backend — Agent Guide

> Read this before modifying anything in `apps/backend/`.

## Structure

```
src/
├── app.ts              ← Hono app, middleware chain, route mounts (import this in tests)
├── index.ts            ← Server startup + background workers (never import in tests)
├── config/             ← YAML config: schema.ts composes sections/*, index.ts loads it
├── db/                 ← Document store
│   ├── types.ts        ← Collection doc shapes + unique specs (THE schema)
│   ├── store.ts        ← Collection/DataStore interfaces + filter matcher
│   ├── memory-store.ts ← Default driver: in-memory, JSON-file persistence
│   ├── mongo-store.ts  ← DB_DRIVER=mongo driver (official mongodb client)
│   ├── client.ts       ← `db` singleton, initDb/closeDb, withSingleFlight
│   ├── errors.ts       ← isUniqueViolation
│   ├── keyed-lock.ts   ← Serialises multi-doc read-modify-writes (was an advisory lock)
│   ├── staff-roles.ts  ← ADR 037 staff grants + the last-admin invariant
│   └── users.ts        ← User repo helpers (find-or-create, token version, admin shim)
├── auth/               ← Loop-native OTP + social login + refresh rotation + purge sweep
├── admin/              ← ADR 017/028/037 admin surface: staff roles, step-up, idempotency,
│                          audit tail, user-360 drill, order triage, cashback rates
├── orders/             ← ADR 052 order mirror: create at CTX, ws/sweep transitions,
│                          redemption backfill, redeem-secret crypto
├── merchants/          ← In-memory catalog synced from CTX + ws maintainer + cashback rates
├── clustering/         ← Location store + map clustering (protobuf wire)
├── ctx/                ← CTX API client, ws maintainers, catalog snapshots, user provisioning
├── users/              ← Profile, home-currency, favorites, recently-purchased, DSR
├── public/             ← /api/public/* (ADR 020: never-500, no PII, CDN-friendly)
├── images/             ← Reference-keyed image proxy (ADR 050)
├── webhooks/           ← HMAC verify helper
├── discord/            ← Webhook notifiers + in-process watchdog alert gate
├── middleware/         ← CORS, rate limit, cache-control, request-id, body limit, …
└── routes/             ← Route mounts per domain (auth, orders, merchants, users, admin, …)
```

## Key patterns

- **Data access** goes through repository modules calling
  `db.collection('<name>')` — handlers never touch the store shape
  directly. Filters are a small Mongo subset (`$lt/$lte/$gt/$gte/$ne/$in`);
  updates are `{$set, $inc}`. `updateOne` is the atomic CAS primitive:
  put the "still live" predicate in the filter; a `null` result means
  another caller won (see `auth/otps.ts` `tryConsumeOtp`).
- **No migrations.** Change `db/types.ts` (+ `COLLECTION_SPECS` for
  unique keys) and the code that reads it. The project is undeployed.
- **Workers** are `start…/stop…` interval pairs started in `index.ts`,
  single-flighted via `withSingleFlight`, reporting into
  `runtime-health.ts` (surfaced on `/health`).
- **Every route mount declares a `rateLimit('METHOD /path', max, win)`**
  — `rate-limit-route-inventory.test.ts` fails CI on any mount without
  one.
- **Every upstream CTX response is Zod-validated** before use.
- **Tests**: unit suites mock at module boundaries; the integration
  suite (`npm run test:integration`) runs real flows against the
  ephemeral memory store — reset state with `__resetDbForTests()`
  from `db/client.js`. No external services needed.

## Adding an endpoint

1. Handler in the domain dir (validate with zod, return the
   `{ code, message }` error envelope on failures).
2. Mount in the matching `routes/*.ts` with a named `rateLimit(...)`.
3. Wire shapes shared with web go in `packages/shared`.
4. Unit test beside the handler; flow test in
   `src/__tests__/integration/` if it touches persisted state.

## Configuration

Settings live in a YAML file, not environment variables. `CONFIG_PATH`
picks the file (default `config.yaml` in the working directory);
`config.example.yaml` is the authoritative reference — update it in the
same commit as any config change.

`src/config/sections/*.ts` hold the zod fields, `src/config/schema.ts`
composes them into `ConfigSchema`, and `src/config/index.ts` reads +
validates the file at boot and exports the typed `config` object
everything else imports. Relationships between settings belong in the
schema (nesting, discriminated unions) so they fail at parse time with
the offending path in the message; only the checks a per-field schema
can't express live in `applyCrossFieldGuards`.

Two settings stay environment variables because no operator authors
them: `CONFIG_PATH` itself, and `NODE_ENV` (which overrides the file's
`env:` key, since node tooling sets it on its own). `FLY_APP_NAME` is
read straight from `process.env` at its single use site.

Tests either mock `../config/index.js` — spreading `importActual()` so
only the settings under test change — or call `parseConfig()` with a
synthetic document. `config.test.yaml` / `config.integration.yaml` are
the committed fixtures the setup files point `CONFIG_PATH` at.
