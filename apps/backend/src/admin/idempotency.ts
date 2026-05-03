/**
 * Admin idempotency guard (ADR 017).
 *
 * Stores `(admin_user_id, key) → response snapshot` for 24h. On a
 * repeat POST with the same pair, the stored snapshot is replayed
 * verbatim so a double-click or a network-retry cannot cause
 * double side-effects (double-credit, double-payout-retry, etc.).
 *
 * This file owns the high-level `withIdempotencyGuard` (advisory-
 * lock-serialised lookup → write → store) plus the request-edge
 * helpers (`validateIdempotencyKey`, `idempotencyLockKey`). The
 * single-row store primitives (`lookupIdempotencyKey`,
 * `storeIdempotencyKey`, `sweepStaleIdempotencyKeys`) live in
 * `./idempotency-store.ts`; the constants in
 * `./idempotency-constants.ts`. Both are re-exported below so the
 * wide network of existing import sites keeps resolving against
 * `'../admin/idempotency.js'`.
 *
 * Missing header is rejected at the handler edge with a 400 — it is
 * NOT the store's responsibility to fabricate a key, because then a
 * retry would look like a new request and side-effects would double.
 */
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { adminIdempotencyKeys } from '../db/schema.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  IDEMPOTENCY_TTL_HOURS,
} from './idempotency-constants.js';

export {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  IDEMPOTENCY_TTL_HOURS,
} from './idempotency-constants.js';

export {
  lookupIdempotencyKey,
  storeIdempotencyKey,
  sweepStaleIdempotencyKeys,
  type IdempotencySnapshot,
} from './idempotency-store.js';

export function validateIdempotencyKey(key: string | undefined): key is string {
  if (key === undefined) return false;
  return key.length >= IDEMPOTENCY_KEY_MIN && key.length <= IDEMPOTENCY_KEY_MAX;
}

/**
 * A2-2001: maps an (adminUserId, key) pair to a 63-bit signed integer
 * suitable for `pg_advisory_xact_lock`. The lock key is consumed by
 * `withIdempotencyGuard` to serialise the lookup → write → store
 * sequence so two concurrent callers with the same idempotency key
 * cannot both pass the initial lookup, both perform the write, and
 * both store a snapshot — which would double-credit the user.
 *
 * SHA-256 the pair, take the first 8 bytes, reinterpret as a signed
 * bigint. 64-bit space; collision probability across distinct pairs
 * is 2^-32 (birthday) — Postgres advisory locks are cheap and the
 * only consequence of a rare false-collision is two unrelated keys
 * briefly serialising, not a correctness bug.
 */
export function idempotencyLockKey(adminUserId: string, key: string): bigint {
  const digest = createHash('sha256').update(`${adminUserId}:${key}`).digest();
  // BigInt.asIntN(64, ...) produces a signed 64-bit from the
  // unsigned buffer; Postgres bigint is signed so we stay in-range.
  const raw =
    (BigInt(digest[0]!) << 56n) |
    (BigInt(digest[1]!) << 48n) |
    (BigInt(digest[2]!) << 40n) |
    (BigInt(digest[3]!) << 32n) |
    (BigInt(digest[4]!) << 24n) |
    (BigInt(digest[5]!) << 16n) |
    (BigInt(digest[6]!) << 8n) |
    BigInt(digest[7]!);
  return BigInt.asIntN(64, raw);
}

export interface IdempotencyGuardArgs {
  adminUserId: string;
  key: string;
  method: string;
  path: string;
}

export interface IdempotencyGuardResult {
  replayed: boolean;
  status: number;
  body: Record<string, unknown>;
}

/**
 * A2-2001: serialises the entire lookup → write → store sequence for
 * a given (adminUserId, key) under a Postgres advisory lock. Before
 * this, two concurrent POSTs with the same key could both see a miss,
 * both call `doWrite()`, and both store a snapshot — the second
 * `ON CONFLICT DO UPDATE` would overwrite the first but the two
 * underlying side-effects (double credit_transactions rows, double
 * balance bump) had already landed.
 *
 * Flow:
 *   1. Open a transaction and acquire `pg_advisory_xact_lock` keyed
 *      by hash(adminUserId, key). Concurrent callers block here.
 *   2. Re-read the snapshot inside the locked txn — if one exists,
 *      return it as a replay (the other caller finished first). The
 *      same TTL gate as `lookupIdempotencyKey()` applies here so the
 *      bounded replay window cannot drift between guarded and manual
 *      paths.
 *   3. Otherwise call `doWrite()`. Its own internal transaction
 *      becomes a SAVEPOINT of the outer txn, so a failure cleanly
 *      rolls back without releasing the lock.
 *   4. Insert the snapshot inside the same txn. Since we hold the
 *      lock, no other caller can race us between write and store.
 *   5. Commit → advisory lock released → queued callers proceed to
 *      step 2 and hit the now-present snapshot.
 *
 * Side-effect contract: `doWrite` MUST be idempotent at the DB layer
 * (e.g. guarded by a unique constraint) because an exceptional path
 * where a caller times out but commits still leaves the write behind.
 * The handler uses storeIdempotencyKey → advisory lock → applyAdmin…
 * which satisfies this.
 */
export async function withIdempotencyGuard(
  args: IdempotencyGuardArgs,
  doWrite: () => Promise<{ status: number; body: Record<string, unknown> }>,
): Promise<IdempotencyGuardResult> {
  const lockKey = idempotencyLockKey(args.adminUserId, args.key);
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey})`);

    const prior = await tx.query.adminIdempotencyKeys.findFirst({
      where: and(
        eq(adminIdempotencyKeys.adminUserId, args.adminUserId),
        eq(adminIdempotencyKeys.key, args.key),
      ),
    });
    if (prior !== undefined) {
      const ageMs = Date.now() - prior.createdAt.getTime();
      if (ageMs <= IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000) {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(prior.responseBody) as Record<string, unknown>;
        } catch {
          // Corrupt stored snapshot — treat as miss and re-run. Falls
          // through into the write path below.
          body = {};
        }
        if (Object.keys(body).length > 0) {
          // ADR-017 + every admin-write OpenAPI entry promises that
          // `audit.replayed: true` on the response body indicates a
          // snapshot replay. The stored body was produced on the first
          // call with `replayed: false`; mutate it here on the replay
          // path so the wire contract matches the docs. Doing it in
          // the guard means every handler using `withIdempotencyGuard`
          // gets the spec-compliant behaviour without per-handler code.
          const audit = body['audit'];
          if (audit !== null && typeof audit === 'object') {
            (audit as Record<string, unknown>)['replayed'] = true;
          }
          return { replayed: true, status: prior.status, body };
        }
      }
    }

    const { status, body } = await doWrite();

    const serialised = JSON.stringify(body);
    await tx
      .insert(adminIdempotencyKeys)
      .values({
        adminUserId: args.adminUserId,
        key: args.key,
        method: args.method,
        path: args.path,
        status,
        responseBody: serialised,
      })
      .onConflictDoUpdate({
        target: [adminIdempotencyKeys.adminUserId, adminIdempotencyKeys.key],
        set: {
          method: args.method,
          path: args.path,
          status,
          responseBody: serialised,
        },
      });

    return { replayed: false, status, body };
  });
}
