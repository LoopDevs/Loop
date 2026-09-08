/**
 * Admin idempotency guard (ADR 017).
 *
 * Stores `(adminUserId, key) → response snapshot` for 24h. On a repeat
 * POST with the same pair the stored snapshot is replayed verbatim, so
 * a double-click or a network retry cannot double the side-effect.
 *
 * This file owns the high-level `withIdempotencyGuard` (the
 * lock-serialised lookup → write → store) plus the request-edge
 * helpers. The single-row primitives live in `./idempotency-store.ts`
 * and the constants in `./idempotency-constants.ts`; both are
 * re-exported below so the import sites across the admin handlers keep
 * resolving against `'../admin/idempotency.js'`.
 *
 * A missing header is rejected at the handler edge with a 400 — it is
 * NOT the store's job to fabricate a key, because then a retry would
 * look like a new request and the side-effect would double.
 */
import { db } from '../db/client.js';
import { withKeyedLock } from '../db/keyed-lock.js';
import { logger } from '../logger.js';
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
  countAppliedActionsForPath,
  type IdempotencySnapshot,
} from './idempotency-store.js';

const log = logger.child({ area: 'admin-idempotency' });

export function validateIdempotencyKey(key: string | undefined): key is string {
  if (key === undefined) return false;
  return key.length >= IDEMPOTENCY_KEY_MIN && key.length <= IDEMPOTENCY_KEY_MAX;
}

/**
 * A2-2001: the lock name serialising one (adminUserId, key) pair. Was
 * a hashed 63-bit `pg_advisory_xact_lock` argument; the in-process
 * lock takes a string, so the pair goes in literally — no hashing, and
 * therefore no collision between unrelated pairs at all.
 */
export function idempotencyLockKey(adminUserId: string, key: string): string {
  return `admin-idempotency:${adminUserId}:${key}`;
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
 * A2-2001: serialises the whole lookup → write → store sequence for a
 * given (adminUserId, key). Without it two concurrent POSTs with the
 * same key could both see a miss, both call `doWrite()`, and both
 * store a snapshot — the second store would overwrite the first, but
 * the two underlying side-effects had already landed.
 *
 * Flow:
 *   1. Acquire the per-pair lock. Concurrent callers queue here.
 *   2. Re-read the snapshot under the lock — if one exists, return it
 *      as a replay (another caller finished first). The same TTL gate
 *      as `lookupIdempotencyKey()` applies, so the bounded replay
 *      window cannot drift between the guarded and manual paths. If
 *      the stored snapshot is corrupt the guard returns a structured
 *      500 (`IDEMPOTENCY_SNAPSHOT_CORRUPT`) instead of re-running the
 *      write — the snapshot only exists because the write committed,
 *      so re-executing would double the side-effect.
 *   3. Otherwise call `doWrite()`, then store its snapshot. Since we
 *      hold the lock, nobody can race us between the two.
 *   4. Release → queued callers proceed to step 2 and hit the
 *      now-present snapshot.
 *
 * The Postgres version ran all of this in one transaction, so a
 * failure between the write and the store rolled both back. The
 * document store has no transaction to roll back, so the contract on
 * `doWrite` is stricter than it was: it MUST be idempotent at the
 * document layer (a compare-and-set `updateOne`, or an `insertOne`
 * guarded by a unique spec), because a crash after the write and
 * before the store leaves the effect applied with no snapshot, and the
 * caller's retry will re-enter `doWrite`.
 */
export async function withIdempotencyGuard(
  args: IdempotencyGuardArgs,
  doWrite: () => Promise<{ status: number; body: Record<string, unknown> }>,
): Promise<IdempotencyGuardResult> {
  return await withKeyedLock(idempotencyLockKey(args.adminUserId, args.key), async () => {
    const rows = db.collection('admin_idempotency_keys');
    const prior = await rows.findOne({ adminUserId: args.adminUserId, key: args.key });
    if (prior !== null) {
      const ageMs = Date.now() - prior.createdAt.getTime();
      if (ageMs <= IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000) {
        let body: Record<string, unknown> | null;
        try {
          const parsed: unknown = JSON.parse(prior.responseBody);
          body =
            parsed !== null &&
            typeof parsed === 'object' &&
            !Array.isArray(parsed) &&
            Object.keys(parsed).length > 0
              ? (parsed as Record<string, unknown>)
              : null;
        } catch {
          body = null;
        }
        if (body === null) {
          // Corrupt stored snapshot. The original write committed (the
          // snapshot is only persisted after it), so silently
          // re-running `doWrite()` would double the side-effect. Fail
          // loud with a structured 500 and leave the row for an
          // operator to inspect.
          log.error(
            {
              adminUserId: args.adminUserId,
              key: args.key,
              method: args.method,
              path: args.path,
              storedStatus: prior.status,
            },
            'Corrupt admin idempotency snapshot — refusing to re-execute the write',
          );
          return {
            replayed: true,
            status: 500,
            body: {
              code: 'IDEMPOTENCY_SNAPSHOT_CORRUPT',
              message:
                'Stored idempotency snapshot is unreadable; the original write was applied but its response cannot be replayed. Do NOT retry with a new key — escalate to ops.',
            },
          };
        }
        // ADR-017 promises that `audit.replayed: true` marks a snapshot
        // replay. The stored body was produced on the first call with
        // `replayed: false`; flip it here so the wire contract matches,
        // and every handler using the guard gets it for free.
        const audit = body['audit'];
        if (audit !== null && typeof audit === 'object') {
          (audit as Record<string, unknown>)['replayed'] = true;
        }
        return { replayed: true, status: prior.status, body };
      }
    }

    const { status, body } = await doWrite();

    const responseBody = JSON.stringify(body);
    if (prior !== null) {
      // The row exists but sat outside the replay window: refresh the
      // response, keeping the original `createdAt` so the audit
      // timestamp stays at the first application.
      await rows.updateOne(
        { adminUserId: args.adminUserId, key: args.key },
        { $set: { method: args.method, path: args.path, status, responseBody } },
      );
    } else {
      await rows.insertOne({
        adminUserId: args.adminUserId,
        key: args.key,
        method: args.method,
        path: args.path,
        status,
        responseBody,
        createdAt: new Date(),
      });
    }

    return { replayed: false, status, body };
  });
}
