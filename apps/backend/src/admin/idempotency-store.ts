/**
 * Admin idempotency store — the single-row CRUD layer (ADR 017).
 *
 * Lifted out of `./idempotency.ts`. Three persistence helpers that
 * operate directly on the `admin_idempotency_keys` table:
 *
 *   - `lookupIdempotencyKey` — read snapshot, TTL-aware
 *   - `storeIdempotencyKey`  — write snapshot (ON CONFLICT DO UPDATE)
 *   - `sweepStaleIdempotencyKeys` — TTL sweep, called from the
 *     app-level cleanup interval
 *
 * The higher-level `withIdempotencyGuard` (which serialises
 * lookup → write → store under a `pg_advisory_xact_lock`) lives in
 * the parent file and uses the in-transaction shape of the same
 * primitives. Both are kept on the same source-of-truth for the
 * 24h TTL via the parent's `IDEMPOTENCY_TTL_HOURS` constant.
 *
 * Re-exported from `./idempotency.ts` so the wide network of
 * existing import sites (admin handlers + tests) keeps resolving.
 */
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { adminIdempotencyKeys } from '../db/schema.js';
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
 * A2-500: hourly sweep that DELETEs admin-idempotency snapshots
 * older than the declared TTL. Called from the app-level cleanup
 * interval. Cheap even at steady state because
 * `admin_idempotency_keys_created_at` is indexed.
 */
export async function sweepStaleIdempotencyKeys(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000);
    const result = await db
      .delete(adminIdempotencyKeys)
      .where(lt(adminIdempotencyKeys.createdAt, cutoff))
      .returning({ key: adminIdempotencyKeys.key });
    if (result.length > 0) {
      log.info(
        { deletedCount: result.length, ttlHours: IDEMPOTENCY_TTL_HOURS },
        'Swept stale admin idempotency snapshots',
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
 * doesn't inflate the count. The table is TTL-swept at the same
 * `IDEMPOTENCY_TTL_HOURS` (24h) window, so callers must keep
 * `windowMs <= that TTL` or older applied actions will have been
 * reaped before the window closes (a shorter effective window only
 * makes the cap *stricter*, never looser — safe direction).
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
