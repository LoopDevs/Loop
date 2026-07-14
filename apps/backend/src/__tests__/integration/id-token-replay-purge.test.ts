/**
 * Real-postgres integration test for the `social_id_token_uses`
 * retention sweep (AGT-06). The unit suite can't exercise the actual
 * `DELETE ... WHERE expires_at < cutoff` SQL — this pins that a row past
 * the retention grace is reaped while any row still inside the window
 * (or whose token is still valid) is spared, so the sweep never weakens
 * replay protection.
 *
 * Runs under `vitest.integration.config.ts` (LOOP_E2E_DB=1 + a real
 * `loop_test` postgres).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';
import { db } from '../../db/client.js';
import { socialIdTokenUses } from '../../db/schema.js';
import { purgeExpiredIdTokenUses } from '../../auth/id-token-replay.js';

const NOW = new Date('2026-07-10T00:00:00Z');
// 48h grace matches the docstring's clock-skew floor; the production
// tick uses the larger shared auth-row retention, which is strictly
// safer (keeps rows even longer). The exact value only needs to be a
// deterministic window the seeds straddle.
const RETENTION_MS = 48 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAllTables();
});

async function seedUse(tokenHash: string, expiresAt: Date): Promise<void> {
  await db.insert(socialIdTokenUses).values({ tokenHash, provider: 'google', expiresAt });
}

async function exists(tokenHash: string): Promise<boolean> {
  const rows = await db
    .select({ tokenHash: socialIdTokenUses.tokenHash })
    .from(socialIdTokenUses)
    .where(eq(socialIdTokenUses.tokenHash, tokenHash));
  return rows.length > 0;
}

describe('purgeExpiredIdTokenUses', () => {
  it('reaps rows past the retention grace but KEEPS recent + still-valid rows', async () => {
    // (c) old: the token expired well past the grace → safe to delete.
    await seedUse('old-past-grace', new Date(NOW.getTime() - RETENTION_MS - HOUR_MS));
    // (b) recently expired but INSIDE the grace → the replay window could
    //     still be live under clock skew → must be kept.
    await seedUse('recent-within-grace', new Date(NOW.getTime() - RETENTION_MS + HOUR_MS));
    // (a) token still valid (exp in the future) → replay protection is
    //     actively load-bearing → must be kept.
    await seedUse('still-valid', new Date(NOW.getTime() + HOUR_MS));

    const deleted = await purgeExpiredIdTokenUses({ retentionMs: RETENTION_MS, now: NOW });

    // Only the past-grace row is reaped.
    expect(deleted).toBe(1);
    expect(await exists('old-past-grace')).toBe(false);
    // Replay protection preserved for everything still needed.
    expect(await exists('recent-within-grace')).toBe(true);
    expect(await exists('still-valid')).toBe(true);
  });

  it('is idempotent — a second sweep with nothing eligible deletes zero', async () => {
    await seedUse('old', new Date(NOW.getTime() - RETENTION_MS - 1000));
    expect(await purgeExpiredIdTokenUses({ retentionMs: RETENTION_MS, now: NOW })).toBe(1);
    // Safe to run repeatedly: the re-run reaps nothing.
    expect(await purgeExpiredIdTokenUses({ retentionMs: RETENTION_MS, now: NOW })).toBe(0);
    expect(await exists('old')).toBe(false);
  });
});
