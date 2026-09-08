/**
 * Admin idempotency store — the single-row CRUD layer (ADR 017).
 *
 * Three persistence helpers over the `admin_idempotency_keys`
 * collection:
 *
 *   - `lookupIdempotencyKey` — read snapshot, replay-TTL-aware
 *   - `storeIdempotencyKey`  — write snapshot (upsert)
 *   - `sweepStaleIdempotencyKeys` — audit-retention sweep, called from
 *     the app-level cleanup interval
 *
 * The higher-level `withIdempotencyGuard` (which serialises
 * lookup → write → store) lives in the parent file. NS-03: the 24h
 * REPLAY window (`IDEMPOTENCY_TTL_HOURS`) is decoupled from the much
 * longer retention window (`admin.auditRetentionDays`) — this
 * collection doubles as the durable admin-action audit trail, which
 * must outlive replay.
 *
 * Re-exported from `./idempotency.ts` so the import sites across the
 * admin handlers keep resolving against `'../admin/idempotency.js'`.
 */
import { config } from '../config/index.js';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { IDEMPOTENCY_TTL_HOURS } from './idempotency-constants.js';

const log = logger.child({ area: 'admin-idempotency' });

export interface IdempotencySnapshot {
  status: number;
  body: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Fetch a prior snapshot for the given (adminUserId, key). Returns
 * null on miss OR on a TTL-expired row. A2-500: expired rows read as a
 * miss so replay semantics match the promised window even in the gap
 * between sweeps (e.g. right after boot).
 */
export async function lookupIdempotencyKey(args: {
  adminUserId: string;
  key: string;
}): Promise<IdempotencySnapshot | null> {
  const row = await db
    .collection('admin_idempotency_keys')
    .findOne({ adminUserId: args.adminUserId, key: args.key });
  if (row === null) return null;
  const ageMs = Date.now() - row.createdAt.getTime();
  if (ageMs > IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000) return null;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(row.responseBody) as Record<string, unknown>;
  } catch {
    // Corrupt snapshot — treat as a miss; the next write overwrites it.
    return null;
  }
  return { status: row.status, body, createdAt: row.createdAt };
}

/**
 * A2-500 / NS-03: sweep that deletes admin-idempotency snapshots older
 * than the AUDIT RETENTION window (`admin.auditRetentionDays`), called
 * from the app-level cleanup interval.
 *
 * The retention window is NOT the 24h replay TTL: this collection is
 * the durable admin-action audit trail (`audit-tail.ts` reads it), so
 * a 24h sweep would silently delete the sole forensic record of every
 * admin write after a day.
 *
 * Replay semantics are preserved: a re-submitted key whose row is
 * RETAINED but older than 24h is a replay MISS (the read-time gate),
 * so `doWrite()` re-executes — exactly as it did when the row would
 * already have been swept.
 *
 * @param args.retentionMs override the retention grace (defaults to
 *        `admin.auditRetentionDays`). Mirrors the `runAuthRowPurgeTick`
 *        seam so tests can drive a short window.
 * @param args.now clock injection for tests.
 */
export async function sweepStaleIdempotencyKeys(args?: {
  retentionMs?: number;
  now?: Date;
}): Promise<number> {
  try {
    const retentionMs = args?.retentionMs ?? config.admin.auditRetentionDays * 24 * 60 * 60 * 1000;
    const cutoff = new Date((args?.now ?? new Date()).getTime() - retentionMs);
    const deleted = await db
      .collection('admin_idempotency_keys')
      .deleteMany({ createdAt: { $lt: cutoff } });
    if (deleted > 0) {
      log.info(
        { deletedCount: deleted, retentionMs },
        'Swept admin idempotency snapshots past audit retention',
      );
    }
    return deleted;
  } catch (err) {
    log.error({ err }, 'Admin idempotency sweep failed');
    return 0;
  }
}

/**
 * A5-3: how many admin actions on this exact `path` were APPLIED
 * within the trailing `windowMs`. Used as a PER-TARGET velocity cap
 * where the path encodes the target (e.g.
 * `/api/admin/users/<uuid>/clear-otp-lockout`), which is what actually
 * bounds a "clear → guess → clear" loop — the per-IP route limit
 * can't, since an attacker's several IPs under one bearer all target
 * one victim.
 *
 * Counts stored snapshots, and a row exists only if the write
 * committed — so this counts APPLIED actions, not attempts. A replay
 * creates no new row, so it doesn't inflate the count.
 *
 * Deliberately does NOT catch its own errors: the caller treats a
 * throw as FAIL-CLOSED (reject the action) so a transient DB error
 * cannot hand an attacker a free, uncounted action.
 */
export async function countAppliedActionsForPath(args: {
  path: string;
  windowMs: number;
  now?: Date;
}): Promise<number> {
  const since = new Date((args.now ?? new Date()).getTime() - args.windowMs);
  return await db
    .collection('admin_idempotency_keys')
    .count({ path: args.path, createdAt: { $gt: since } });
}

/**
 * Persist a completed snapshot. Upserts so a re-post with the same key
 * idempotently refreshes the stored response (e.g. after a crash
 * between the write and the store). `createdAt` on an existing row is
 * deliberately left alone so the audit timestamp stays at the first
 * write.
 */
export async function storeIdempotencyKey(args: {
  adminUserId: string;
  key: string;
  method: string;
  path: string;
  status: number;
  body: Record<string, unknown>;
}): Promise<void> {
  const responseBody = JSON.stringify(args.body);
  const rows = db.collection('admin_idempotency_keys');
  const updated = await rows.updateOne(
    { adminUserId: args.adminUserId, key: args.key },
    { $set: { method: args.method, path: args.path, status: args.status, responseBody } },
  );
  if (updated !== null) return;
  await rows.insertOne({
    adminUserId: args.adminUserId,
    key: args.key,
    method: args.method,
    path: args.path,
    status: args.status,
    responseBody,
    createdAt: new Date(),
  });
}
