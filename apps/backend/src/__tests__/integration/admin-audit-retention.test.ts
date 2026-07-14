/**
 * NS-03: admin money-move AUDIT-trail retention integration test.
 *
 * `admin_idempotency_keys` is BOTH the idempotency-replay store AND the
 * sole durable record of every admin money-move (refunds, emissions,
 * credit-adjustments — surfaced by `admin/audit-tail.ts` and
 * `admin/user-audit-timeline.ts`, which READ this table). Before NS-03,
 * `sweepStaleIdempotencyKeys()` DELETEd rows past `IDEMPOTENCY_TTL_HOURS`
 * (24h) — so the forensic/regulatory audit self-deleted after a day.
 *
 * The fix DECOUPLES the two uses: the 24h REPLAY-hit window
 * (`IDEMPOTENCY_TTL_HOURS`) is unchanged, while the SWEEP cutoff moves
 * to a much longer audit-retention window
 * (`LOOP_ADMIN_AUDIT_RETENTION_DAYS`, ~7y default; overridable per-call
 * via `retentionMs`).
 *
 * This suite proves, against real postgres, the whole invariant the
 * finding demands:
 *   - a money-move audit row OLDER than 24h but WITHIN retention is
 *     STILL PRESENT after a sweep, and is STILL surfaced by BOTH audit
 *     reads (fleet-wide `adminAuditTailHandler` + per-subject
 *     `adminUserAuditTimelineHandler`);
 *   - a row PAST the full retention window IS swept;
 *   - the REPLAY window still behaves as 24h — a replay within 24h HITS
 *     the cache, a re-submit after 24h is a MISS — independent of the
 *     (now long) retention.
 *
 * RED on the un-fixed code: with the sweep reaping at the 24h TTL, the
 * 48h-old row is deleted, the DB row-count assertion drops to 1, and
 * both audit reads stop returning it.
 *
 * Same `LOOP_E2E_DB=1` gate / fork pool / per-test truncate as the
 * sibling admin integration suites.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

import { db } from '../../db/client.js';
import { adminIdempotencyKeys } from '../../db/schema.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import {
  lookupIdempotencyKey,
  sweepStaleIdempotencyKeys,
  IDEMPOTENCY_TTL_HOURS,
} from '../../admin/idempotency.js';
import { adminAuditTailHandler } from '../../admin/audit-tail.js';
import { adminUserAuditTimelineHandler } from '../../admin/user-audit-timeline.js';
import { env } from '../../env.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A throwaway Hono app that mounts the two real audit READ handlers
 * (no auth middleware — the handlers only touch `c.req` + `c.json`). */
function auditReadApp(): Hono {
  const a = new Hono();
  a.get('/audit-tail', adminAuditTailHandler);
  a.get('/users/:userId/audit', adminUserAuditTimelineHandler);
  return a;
}

interface AuditTailBody {
  rows: Array<{ actorUserId: string; path: string; status: number; createdAt: string }>;
}
interface TimelineBody {
  events: Array<{ kind: string; summary: string; detail: Record<string, unknown> }>;
}

/** Seeds one admin money-move audit row with an explicit age. */
async function seedAuditRow(args: {
  adminUserId: string;
  key: string;
  targetUserId: string;
  createdAt: Date;
}): Promise<void> {
  await db.insert(adminIdempotencyKeys).values({
    adminUserId: args.adminUserId,
    key: args.key,
    method: 'POST',
    path: `/api/admin/users/${args.targetUserId}/credit-adjustments`,
    status: 200,
    responseBody: JSON.stringify({
      result: { balanceMinor: '1500' },
      audit: { replayed: false },
    }),
    createdAt: args.createdAt,
  });
}

describeIf('NS-03 admin money-move audit retention', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  it('retains a >24h money-move audit row within retention (surfaced by both audit reads), sweeps a past-retention row, and keeps the replay window at 24h', async () => {
    const admin = await findOrCreateUserByEmail('ns03-admin@example.com');
    const target = await findOrCreateUserByEmail('ns03-target@example.com');

    const now = new Date();
    // A: 12h old — within the 24h replay window AND within retention.
    const keyRecent = 'ns03-recent-'.padEnd(32, 'a');
    // B: 48h old — PAST the 24h replay window, WITHIN retention. THE
    //    row the finding is about: its money-move audit must survive.
    const keyAged = 'ns03-aged-'.padEnd(32, 'b');
    // C: 40 days old — PAST the (test) 30-day retention → must be swept.
    const keyExpired = 'ns03-expired-'.padEnd(32, 'c');

    await seedAuditRow({
      adminUserId: admin.id,
      key: keyRecent,
      targetUserId: target.id,
      createdAt: new Date(now.getTime() - 12 * HOUR_MS),
    });
    await seedAuditRow({
      adminUserId: admin.id,
      key: keyAged,
      targetUserId: target.id,
      createdAt: new Date(now.getTime() - 48 * HOUR_MS),
    });
    await seedAuditRow({
      adminUserId: admin.id,
      key: keyExpired,
      targetUserId: target.id,
      createdAt: new Date(now.getTime() - 40 * DAY_MS),
    });

    // Sweep with a 30-day retention override (shorter than the ~7y
    // default so the test can construct a "past retention" row cheaply).
    const retentionMs = 30 * DAY_MS;
    const deleted = await sweepStaleIdempotencyKeys({ retentionMs });
    expect(deleted).toBe(1); // only the 40-day-old row

    // ── DB state: recent + aged retained, expired gone ──────────────────
    const remaining = await db
      .select({ key: adminIdempotencyKeys.key })
      .from(adminIdempotencyKeys)
      .where(eq(adminIdempotencyKeys.adminUserId, admin.id));
    const remainingKeys = remaining.map((r) => r.key).sort();
    expect(remainingKeys).toEqual([keyAged, keyRecent].sort());

    // ── Audit read #1: fleet-wide audit-tail surfaces BOTH survivors,
    //    including the >24h aged money-move ─────────────────────────────
    const app = auditReadApp();
    const tailRes = await app.request('/audit-tail?limit=100');
    expect(tailRes.status).toBe(200);
    const tail = (await tailRes.json()) as AuditTailBody;
    const tailKeysPaths = tail.rows.filter((r) => r.actorUserId === admin.id);
    expect(tailKeysPaths).toHaveLength(2);
    // The aged (>24h) audit record is present — the crux of NS-03.
    expect(
      tail.rows.some(
        (r) =>
          r.actorUserId === admin.id &&
          new Date(r.createdAt).getTime() < now.getTime() - 24 * HOUR_MS,
      ),
    ).toBe(true);

    // ── Audit read #2: per-subject timeline also surfaces the aged
    //    money-move admin_action for the target user ────────────────────
    const tlRes = await app.request(`/users/${target.id}/audit?limit=20`);
    expect(tlRes.status).toBe(200);
    const tl = (await tlRes.json()) as TimelineBody;
    const adminActions = tl.events.filter((e) => e.kind === 'admin_action');
    expect(adminActions).toHaveLength(2);
    expect(
      adminActions.every((e) =>
        String(e.detail['path']).includes(`/api/admin/users/${target.id}/`),
      ),
    ).toBe(true);

    // ── Replay window is STILL 24h, independent of the long retention ──
    // Recent (12h): replay HIT — the cached snapshot is returned.
    const recentReplay = await lookupIdempotencyKey({ adminUserId: admin.id, key: keyRecent });
    expect(recentReplay).not.toBeNull();
    expect(recentReplay?.status).toBe(200);
    // Aged (48h): replay MISS — retained for audit, but past the 24h
    // replay window a re-submit re-executes rather than replays.
    const agedReplay = await lookupIdempotencyKey({ adminUserId: admin.id, key: keyAged });
    expect(agedReplay).toBeNull();

    // Sanity: the replay window constant is genuinely 24h and the
    // retention override is genuinely longer (decoupling holds).
    expect(IDEMPOTENCY_TTL_HOURS).toBe(24);
    expect(retentionMs).toBeGreaterThan(IDEMPOTENCY_TTL_HOURS * HOUR_MS);
  });

  it('default retention (LOOP_ADMIN_AUDIT_RETENTION_DAYS, ~7y) sweeps nothing at day-scale ages', async () => {
    // Proves the env-default path (no override): the ~7y window keeps a
    // 90-day-old money-move audit row.
    expect(env.LOOP_ADMIN_AUDIT_RETENTION_DAYS).toBeGreaterThan(365);
    const admin = await findOrCreateUserByEmail('ns03-admin2@example.com');
    const target = await findOrCreateUserByEmail('ns03-target2@example.com');
    const key = 'ns03-default-'.padEnd(32, 'd');
    await seedAuditRow({
      adminUserId: admin.id,
      key,
      targetUserId: target.id,
      createdAt: new Date(Date.now() - 90 * DAY_MS),
    });

    const deleted = await sweepStaleIdempotencyKeys();
    expect(deleted).toBe(0);

    const [row] = await db
      .select({ key: adminIdempotencyKeys.key })
      .from(adminIdempotencyKeys)
      .where(
        and(eq(adminIdempotencyKeys.adminUserId, admin.id), eq(adminIdempotencyKeys.key, key)),
      );
    expect(row?.key).toBe(key);
  });
});
