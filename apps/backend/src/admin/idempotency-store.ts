/**
 * Admin idempotency store — the single-row CRUD layer (ADR 017).
 *
 * Lifted out of `./idempotency.ts`. Three persistence helpers that
 * operate directly on the `admin_idempotency_keys` table:
 *
 *   - `lookupIdempotencyKey` — read snapshot, replay-TTL-aware
 *   - `storeIdempotencyKey`  — write snapshot (ON CONFLICT DO UPDATE)
 *   - `sweepStaleIdempotencyKeys` — audit-retention sweep, called from
 *     the app-level cleanup interval
 *
 * The higher-level `withIdempotencyGuard` (which serialises
 * lookup → write → store under a `pg_advisory_xact_lock`) lives in
 * the parent file and uses the in-transaction shape of the same
 * primitives. NS-03: the 24h REPLAY window (`IDEMPOTENCY_TTL_HOURS`,
 * enforced at read time by `lookupIdempotencyKey` + the guard) is now
 * decoupled from the much longer sweep/retention window
 * (`LOOP_ADMIN_AUDIT_RETENTION_DAYS`) — this table doubles as the
 * durable admin money-move audit trail, which must outlive replay.
 *
 * Re-exported from `./idempotency.ts` so the wide network of
 * existing import sites (admin handlers + tests) keeps resolving.
 */
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { adminIdempotencyKeys } from '../db/schema.js';
import { env } from '../env.js';
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
 * null on miss OR on a TTL-expired row. A2-500: expired rows are
 * treated as a miss so replay semantics match the promised 24h
 * window even in the gap between scheduled sweeps (e.g. right after
 * boot, before `sweepStaleIdempotencyKeys()` has fired).
 */
export async function lookupIdempotencyKey(args: {
  adminUserId: string;
  key: string;
}): Promise<IdempotencySnapshot | null> {
  const row = await db.query.adminIdempotencyKeys.findFirst({
    where: and(
      eq(adminIdempotencyKeys.adminUserId, args.adminUserId),
      eq(adminIdempotencyKeys.key, args.key),
    ),
  });
  if (row === undefined) return null;
  // A2-500: TTL gate. A row older than the declared window is
  // treated as absent; the next write will overwrite it via the
  // ON CONFLICT path in storeIdempotencyKey.
  const ageMs = Date.now() - row.createdAt.getTime();
  if (ageMs > IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000) return null;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(row.responseBody) as Record<string, unknown>;
  } catch {
    // Stored snapshot is corrupt — treat as a miss. The next write
    // will overwrite it via insert-on-conflict-do-update.
    return null;
  }
  return { status: row.status, body, createdAt: row.createdAt };
}

/**
 * A2-500 / NS-03: hourly sweep that DELETEs admin-idempotency
 * snapshots older than the AUDIT RETENTION window. Called from the
 * app-level cleanup interval. Cheap even at steady state because
 * `admin_idempotency_keys_created_at` is indexed.
 *
 * NS-03: the retention window is NOT the 24h replay TTL. This table
 * is the durable admin money-move audit trail (`audit-tail.ts` /
 * `user-audit-timeline.ts` read it), so a 24h sweep silently deleted
 * the sole forensic record of refunds/emissions/adjustments after a
 * day. Retention now defaults to `LOOP_ADMIN_AUDIT_RETENTION_DAYS`
 * (~7 years, financial-records grade) while the 24h REPLAY window
 * (`IDEMPOTENCY_TTL_HOURS`, enforced at read time in
 * `lookupIdempotencyKey` / `withIdempotencyGuard`) is unchanged.
 *
 * Replay semantics are preserved: a re-submitted key whose row is
 * RETAINED but older than 24h is a replay MISS (read-time gate), so
 * `doWrite()` re-executes — exactly as it did before this change,
 * when the row would already have been swept. The subsequent snapshot
 * INSERT then hits the retained row's PK and is absorbed by the
 * existing `ON CONFLICT DO UPDATE` (it refreshes method/path/status/
 * body; `created_at` is deliberately left untouched so the audit
 * timestamp of a crash-recovery re-store stays at the first write).
 *
 * @param args.retentionMs override the retention grace (defaults to
 *        `LOOP_ADMIN_AUDIT_RETENTION_DAYS`). Mirrors the
 *        `runAuthRowPurgeTick` seam so tests can drive a short window.
 * @param args.now clock injection for tests.
 */
export async function sweepStaleIdempotencyKeys(args?: {
  retentionMs?: number;
  now?: Date;
}): Promise<number> {
  try {
    const retentionMs =
      args?.retentionMs ?? env.LOOP_ADMIN_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const cutoff = new Date((args?.now ?? new Date()).getTime() - retentionMs);
    const result = await db
      .delete(adminIdempotencyKeys)
      .where(lt(adminIdempotencyKeys.createdAt, cutoff))
      .returning({ key: adminIdempotencyKeys.key });
    if (result.length > 0) {
      log.info(
        { deletedCount: result.length, retentionMs },
        'Swept admin idempotency snapshots past audit retention',
      );
    }
    return result.length;
  } catch (err) {
    log.error({ err }, 'Admin idempotency sweep failed');
    return 0;
  }
}

/**
 * A5-3: count how many admin actions on a given exact `path` were
 * APPLIED within the trailing `windowMs`. Used by
 * `clear-otp-lockout.ts` as a PER-TARGET velocity cap (the path
 * encodes the target `:userId`, e.g.
 * `/api/admin/users/<uuid>/clear-otp-lockout`), which is what actually
 * bounds the "clear → guess → clear" B5-defeat loop — the per-IP route
 * limit can't (an attacker's several IPs under one bearer all target
 * one victim).
 *
 * Counts stored idempotency rows, and a row exists only if the write
 * committed — so this is a count of APPLIED actions, not attempts. A
 * replay of an already-applied action does NOT create a new row, so it
 * doesn't inflate the count. The `windowMs <= retention` invariant the
 * cap relies on (older applied actions must not have been reaped before
 * the window closes) is now satisfied with a huge margin: NS-03
 * decoupled the sweep from the 24h replay TTL onto the
 * `LOOP_ADMIN_AUDIT_RETENTION_DAYS` audit-retention window (~7 years),
 * so any sane velocity `windowMs` sits far inside it. (A shorter
 * effective window only makes the cap *stricter*, never looser — safe
 * direction — but with year-scale retention that no longer bites.)
 *
 * Deliberately does NOT catch its own errors: the sole caller treats a
 * throw as FAIL-CLOSED (reject the action) so a transient DB error
 * cannot hand an attacker a free, uncounted action.
 */
export async function countAppliedActionsForPath(args: {
  path: string;
  windowMs: number;
  now?: Date;
}): Promise<number> {
  const since = new Date((args.now ?? new Date()).getTime() - args.windowMs);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(adminIdempotencyKeys)
    .where(
      and(eq(adminIdempotencyKeys.path, args.path), gt(adminIdempotencyKeys.createdAt, since)),
    );
  return row?.n ?? 0;
}

/**
 * Persist a completed snapshot. Uses ON CONFLICT DO UPDATE so a
 * re-post with the same key idempotently refreshes the stored
 * response (e.g. after a crash between commit and store).
 */
export async function storeIdempotencyKey(args: {
  adminUserId: string;
  key: string;
  method: string;
  path: string;
  status: number;
  body: Record<string, unknown>;
}): Promise<void> {
  const serialised = JSON.stringify(args.body);
  await db
    .insert(adminIdempotencyKeys)
    .values({
      adminUserId: args.adminUserId,
      key: args.key,
      method: args.method,
      path: args.path,
      status: args.status,
      responseBody: serialised,
    })
    .onConflictDoUpdate({
      target: [adminIdempotencyKeys.adminUserId, adminIdempotencyKeys.key],
      set: {
        method: args.method,
        path: args.path,
        status: args.status,
        responseBody: serialised,
      },
    });
}
