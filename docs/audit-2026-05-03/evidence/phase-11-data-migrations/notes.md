# Phase 11 - Data Layer and Migrations

Status: in-progress

Required evidence:

- schema vs SQL migration matrix: complete for current schema table inventory, integration truncate list, SQL files, and journal entries
- migration journal review: complete for SQL/journal parity through 0028
- constraints/indexes/triggers review: complete against real-Postgres migrated schema samples
- transaction/isolation review: in progress
- fresh deploy and rollback assumptions: finding filed for migration asset packaging

Artifacts:

- [schema-journal-table-matrix.txt](./artifacts/schema-journal-table-matrix.txt)
- [migration-runtime-packaging.txt](./artifacts/migration-runtime-packaging.txt)
- [real-postgres-migration-check.txt](./artifacts/real-postgres-migration-check.txt)

Observations:

- `apps/backend/drizzle.config.ts` exists in the backend workspace and `npx drizzle-kit check --config drizzle.config.ts` reports the current migration folder is internally consistent.
- Current schema exports 13 tables. The real-postgres integration-test truncate list includes all 13 tables.
- SQL migration files and `_journal.json` entries are aligned for 0000 through 0028.
- `npm run test:integration -w @loop/backend` passed against the local real-Postgres container, applying all checked-in source migrations to `loop_test`.
- The migrated database contains 13 public tables, 29 recorded Drizzle migrations, the cashback-config audit trigger/function, and the sampled indexes/check constraints expected from the current migration series.
- Runtime migration packaging is not aligned: built `dist` lacks migration SQL and meta files even though the bundled runtime resolves `./migrations` beside the built chunk.

Findings:

- A4-023: Production backend image does not ship database migration files required by release and boot migrations.
