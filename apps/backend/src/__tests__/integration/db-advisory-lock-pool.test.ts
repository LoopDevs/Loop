/**
 * DB-backed regression for FT-12: `withAdvisoryLock` must not be able to
 * deadlock the connection pool.
 *
 * Each holder pins ONE pool connection for the lock's lifetime
 * (`client.reserve()`) AND its `fn` body draws at least one MORE from
 * the SAME pool. Before the fix, launching more than `DATABASE_POOL_MAX`
 * concurrent holders on DISTINCT lock keys reserved every pool member,
 * then every `fn` body queued forever for a connection that never freed
 * (postgres-js queues acquisitions with no timeout) — a hard deadlock.
 *
 * The fix caps concurrent holders at floor(poolMax / 2) so at least
 * ceil(poolMax / 2) connections always remain for the bodies. This test
 * launches poolMax + 2 concurrent holders whose bodies each run a real
 * `pg_sleep` query (forcing pool contention) and asserts they ALL
 * complete (no deadlock) while the peak number of simultaneously-running
 * bodies never exceeds the cap.
 *
 * Proven red: revert the FT-12 semaphore in `db/client.ts` and this test
 * hangs until the vitest timeout (the un-fixed pool deadlocks). It runs
 * under `vitest.integration.config.ts` (real `loop_test` postgres).
 */
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withAdvisoryLock, maxConcurrentLockHolders } from '../../db/client.js';
import { env } from '../../env.js';

describe('withAdvisoryLock pool sizing (FT-12)', () => {
  it('does not deadlock the pool under more holders than connections, and bounds concurrency', async () => {
    // More concurrent holders than the pool has connections — the exact
    // shape that deadlocked before the cap.
    const holders = env.DATABASE_POOL_MAX + 2;
    // High, arbitrary base key so distinct keys don't collide with other
    // suites' advisory locks. Distinct keys => every holder wins its
    // `pg_try_advisory_lock` and therefore runs its `fn` body.
    const baseKey = 0x7f00_0000_0000_0000n;

    let activeBodies = 0;
    let peakBodies = 0;
    let completed = 0;

    const results = await Promise.all(
      Array.from({ length: holders }, (_, i) =>
        withAdvisoryLock(baseKey + BigInt(i), async () => {
          activeBodies += 1;
          peakBodies = Math.max(peakBodies, activeBodies);
          try {
            // A real query that needs a SECOND pool connection while the
            // lock's reserved connection is still held — the contention
            // that produced the deadlock.
            await db.execute(sql`SELECT pg_sleep(0.05)`);
          } finally {
            activeBodies -= 1;
          }
          completed += 1;
          return i;
        }),
      ),
    );

    // No deadlock: every holder ran and returned.
    expect(results).toHaveLength(holders);
    expect(results.every((r) => typeof r === 'object' && r.ran === true)).toBe(true);
    expect(completed).toBe(holders);

    // The cap held: bodies never exceeded floor(poolMax / 2)...
    expect(peakBodies).toBeLessThanOrEqual(maxConcurrentLockHolders);
    // ...and real concurrency did happen (not accidental serialisation),
    // so the bound is a genuine ceiling, not a vacuous pass.
    expect(peakBodies).toBeGreaterThan(1);
  }, 15_000);
});
