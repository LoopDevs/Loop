import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit reads this at generate / migrate time. Points at the
 * schema file and the checked-in migrations folder; the URL is read
 * from DATABASE_URL at the shell (drizzle-kit doesn't go through our
 * `env.ts` wrapper).
 *
 * A2-412 + A2-703: this project uses **hand-written SQL migrations**,
 * not drizzle-generated ones. The snapshot chain in
 * `src/db/migrations/meta/` only carries `0000_snapshot.json` —
 * migrations 0001..N are SQL files written by humans because several
 * shapes the schema requires (trigger-based audit tables, partial
 * unique indexes with expression predicates, cross-column CHECKs)
 * aren't representable in the Drizzle schema diff. Running
 * `npm run db:generate` would DROP the audit trigger from ADR 011
 * and re-emit a huge SQL diff against the ancient baseline. Don't.
 *
 * Invocations:
 *   npm run db:generate   → escape hatch for emergency re-baselining
 *                           only. Coordinate with the team; see
 *                           apps/backend/AGENTS.md "Recipe: Add a DB
 *                           migration" for the normal flow.
 *   npm run db:migrate    → apply migrations (usually only used
 *                           in dev; prod runs via `runMigrations()`
 *                           at backend startup).
 *   npm run db:studio     → local Drizzle Studio UI against
 *                           DATABASE_URL.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://loop:loop@localhost:5433/loop',
  },
  // Emit the schema diff in a single migration file per invocation
  // rather than split per-table — makes the reviewer's job easier and
  // keeps the migration folder flat.
  strict: true,
  verbose: true,
});
