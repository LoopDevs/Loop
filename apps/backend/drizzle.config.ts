import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit reads this at generate / migrate time. Points at the
 * schema file and the checked-in migrations folder; the URL is read
 * from DATABASE_URL at the shell (drizzle-kit doesn't go through our
 * `env.ts` wrapper).
 *
 * Invocations:
 *   npm run db:generate   → create a new migration from schema diff
 *   npm run db:migrate    → apply migrations (usually only used
 *                           in dev; prod runs via `runMigrations()`
 *                           at backend startup)
 *   npm run db:studio     → local Drizzle Studio UI against DATABASE_URL
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
