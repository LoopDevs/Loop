/**
 * DB-backed regression for BK-stmttimeout: the app `statement_timeout`
 * must NOT cover the migration connection.
 *
 * The app pool sets `statement_timeout` as a startup parameter (30s by
 * default) so a runaway query can't hog a pool slot. Before the fix,
 * `runMigrations` ran `migrate(db, ...)` through that SAME pool, so a
 * long legitimate migration (big table rewrite / index build / backfill)
 * would be aborted mid-flight by the 30s app timeout. The fix runs
 * migrations on a dedicated `createMigrationClient()` connection that
 * omits the app timeout.
 *
 * `SHOW statement_timeout` reflects the startup parameter each
 * connection was opened with, so this asserts the scoping directly and
 * cheaply (no 30s sleep needed): the migration client reports `0` (off),
 * while the app pool still reports the configured non-zero value.
 *
 * Proven red: make `createMigrationClient` re-add the app
 * `statement_timeout` (the pre-fix behaviour, i.e. what `migrate(db,…)`
 * used) and the first assertion fails ('30s' !== '0'). Runs under
 * `vitest.integration.config.ts` (real `loop_test` postgres).
 */
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, createMigrationClient } from '../../db/client.js';

describe('statement_timeout scoping (BK-stmttimeout)', () => {
  it('the migration connection is NOT subject to the app statement_timeout', async () => {
    const migrationClient = createMigrationClient();
    try {
      const rows = await migrationClient<{ statement_timeout: string }[]>`SHOW statement_timeout`;
      // '0' = off: a long migration runs to completion, never aborted by
      // the app query timeout.
      expect(rows[0]?.statement_timeout).toBe('0');
    } finally {
      await migrationClient.end({ timeout: 5 });
    }
  });

  it('the app pool DOES still apply statement_timeout (protection preserved)', async () => {
    const rows = (await db.execute(sql`SHOW statement_timeout`)) as unknown as Array<{
      statement_timeout: string;
    }>;
    const list = Array.isArray(rows) ? rows : (rows as { rows: typeof rows }).rows;
    // Non-zero: ordinary app queries are still bounded (default 30s ->
    // postgres renders it as '30s'). The exact string is left loose so
    // the assertion survives a re-tuned DATABASE_STATEMENT_TIMEOUT_MS.
    expect(list[0]?.statement_timeout).not.toBe('0');
  });
});
