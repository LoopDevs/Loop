/**
 * Migration-only entry point — runs `runMigrations()` and exits.
 *
 * A2-407: Fly's `[deploy] release_command` runs a one-shot machine
 * against the production env BEFORE the new release takes traffic.
 * A failing release_command aborts the deploy; the old machines keep
 * serving. That's strictly safer than the boot-time migration in
 * `index.ts`, which would let a partially-migrated schema become
 * visible to traffic before any operator sees the error.
 *
 * The boot-time call in `index.ts` is intentionally kept as a
 * belt-and-braces safety net: a release_command that succeeds but
 * a Machine that somehow rolled to a commit pre-migration still
 * applies pending migrations before accepting traffic. `runMigrations()`
 * is idempotent (drizzle-orm's migrator no-ops on an up-to-date DB).
 */
import { env } from './env.js';
import { logger } from './logger.js';
import { runMigrations, closeDb } from './db/client.js';

async function main(): Promise<void> {
  if (env.NODE_ENV === 'test') {
    // Matches the guard in index.ts — the mocked e2e harness sets a
    // placeholder DATABASE_URL and no live Postgres listens for it.
    logger.info('NODE_ENV=test — skipping migrate-cli.');
    return;
  }
  try {
    await runMigrations();
    logger.info('Migrations applied successfully');
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  logger.error({ err }, 'Migration run failed — aborting deploy');
  // Non-zero exit fails Fly's release_command, which aborts the
  // deploy before any user traffic hits the new machines.
  process.exit(1);
});
