# ADR 012: Database stack — Drizzle ORM + Fly Postgres

Status: Accepted
Date: 2026-04-21
Related: ADR 009 (credits ledger), ADR 010 (principal switch), ADR 011 (admin panel)

## Context

ADR 009 introduces a Postgres credits ledger as the first piece of
persisted state in the Loop backend. Until now the backend has been
stateless: a Hono proxy over CTX with an in-memory merchant cache,
no ORM, no migrations, nothing to back up.

Adding a database is a foundational change. We need to pick:

- A **database engine** (Postgres a given — SQL, ACID, wide ecosystem).
- A **query / ORM layer** (hand-rolled SQL vs. a query builder vs. a
  full ORM).
- A **migration tool** (SQL files + discipline vs. generated).
- A **host** for production + a local-dev story.

## Decision

### ORM: Drizzle

Drizzle is a TypeScript-native schema-in-code ORM. Schema files are
plain TS with typed column helpers; the type system infers row types
directly without codegen; `drizzle-kit` produces raw-SQL migration
files from schema diffs that we check in.

Reasons for Drizzle over the alternatives:

- **TS-native fits our codebase.** The rest of the backend is
  ES-module TS with Zod schemas; Drizzle's idioms compose with that
  cleanly. No `.prisma` DSL or external schema registry to maintain.
- **No codegen step.** Prisma requires a client-generation step and
  the generated client is ~6-8MB. Drizzle is a few hundred kB of
  runtime with types inferred on the fly.
- **SQL-first mental model.** Drizzle's query builder stays close to
  SQL, so debugging is a matter of looking at what it emits; it's
  not an abstraction that needs a leak before you learn it.
- **Active development, good Postgres support.** First-class support
  for `jsonb`, `numeric`, `timestamptz`, `uuid`, triggers via raw SQL
  migrations, row-level locks — all the things our ledger cares
  about.

Rejected alternatives:

1. **Prisma.** Heavier runtime, codegen step, `.prisma` DSL split from
   TS. Good product but mismatch with our lightweight stack.
2. **Kysely.** Lower-level query builder without opinionated migration
   tooling. Less DX for the 90% of queries we'll write; we'd have to
   bolt on our own migration runner. Reasonable if we were going
   handwritten-SQL purist; we're not.
3. **Raw `pg`.** No. We'd rebuild a worse ORM in 18 months.

### Driver: `postgres` (porsager)

Pairs with Drizzle's `drizzle-orm/postgres-js` adapter. Smaller than
`pg` (no optional dependency on native build tools), prepared-statement
caching by default, good connection-pooling story.

### Migrations

`drizzle-kit generate` produces timestamped SQL files under
`apps/backend/src/db/migrations/`. Every migration checked in; the
repo is the source of truth, and CI fails a PR that ships a schema
change without a corresponding migration file.

Applied via `drizzle-kit migrate` in a startup hook on the backend —
so a fresh deploy applies any pending migrations before it starts
serving. Keeps the deploy story simple; no separate
"migrate-then-deploy" orchestration. For bigger migrations that
need downtime windows, we'll use a feature flag to gate the old
code path while the schema change lands, same as most Rails teams.

### Host: Fly Postgres

- Already on Fly for the backend app. Attaching a Fly-managed
  Postgres is `flyctl postgres create` + `flyctl postgres attach`,
  which sets `DATABASE_URL` on the app automatically.
- Daily snapshots, point-in-time recovery.
- Reasonable price curve for our scale; trivial to scale up when
  needed.

Rejected Neon for now despite better branch-per-PR DX. We can
migrate later if preview-environment branching becomes a real need;
for two engineers iterating on main it's not worth the added
surface.

### Local dev

Docker Compose brings up a Postgres 16 container on port 5433 (off
the default 5432 so it doesn't clash with any host-installed Postgres).
`DATABASE_URL=postgres://loop:loop@localhost:5433/loop` in
`apps/backend/.env` (template at `apps/backend/.env.example`).
`docker compose up -d db` is the only command a new engineer runs.

Seeds are not shipped in-repo today — each integration test constructs
the fixtures it needs inline. If ad-hoc demo data ever becomes
valuable, the convention is to add `apps/backend/src/scripts/seed-*.ts`

- an `npm run seed:<name>` entry per dataset, not a single
  "run everything" script (tests already clear state between suites).

### Connection pooling

Hono on Node runs single-process per Fly machine. A single
`postgres` client with the default pool (10 connections) is enough
at current scale; we'll size up alongside traffic. Drizzle exposes
the pool directly on the client for tuning.

### Test database

Vitest suites that touch persistence use a test-only DB name
(`loop_test`), brought up in the same Docker Compose service with a
second database alongside the dev one. Each test file truncates the
tables it touches in a `beforeEach` — simple; fast enough.

### Env var

One new required env var:

```
DATABASE_URL=postgres://user:pass@host:port/dbname
```

Added to `env.ts`, documented in `.env.example`, covered by
`lint-docs.sh`'s env-parity check.

## Alternatives considered

- **SQLite** — single-writer is a hard ceiling for a transactional
  ledger. Rejected early.
- **MySQL** — no strong reason over Postgres; Postgres has better
  SQL expressiveness, `jsonb`, and Fly's managed offering.
- **Firestore / DynamoDB** — schema flexibility at the cost of
  relational guarantees. An audit-grade ledger benefits enormously
  from constraints, transactions, and joins.
- **In-process SQLite on Fly volumes** — tempting for simplicity,
  lost to the single-machine / single-writer constraint and
  backup-replication complexity once we scale past one Fly machine.

## Consequences

- New runtime deps: `drizzle-orm`, `postgres`. New dev deps:
  `drizzle-kit`. Small footprint.
- New env var (`DATABASE_URL`) becomes required. Backend startup
  fails loudly if missing, per existing `env.ts` discipline.
- Developers need Docker running for local backend dev. Already the
  case informally; now enforced.
- Schema changes flow through PR review like any code — generated
  migration + schema diff in the same commit.
- Production deploys now have a "migration" step implicit at startup.
  Mitigation: each migration is backwards-compatible with the
  previous code version for one release (the "expand-contract"
  pattern) so rollbacks are safe.
- We own a new piece of infrastructure. Fly Postgres handles the
  boring bits (backups, snapshots, HA with paid tier) but we need a
  runbook for `postgres` outages.

## References

- [Drizzle ORM docs](https://orm.drizzle.team/docs/overview)
- [Fly Postgres docs](https://fly.io/docs/postgres/)
- [postgres (porsager)](https://github.com/porsager/postgres) driver
