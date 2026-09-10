// Admin idempotency guard — ADR 017, A2-2001
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

// A2-2001: literal pair in lock name prevents collisions between unrelated pairs
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

// A2-2001: serializes lookup → write → store to prevent concurrent double-execution
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
          // Corrupt snapshot: original write committed, so re-running would double the side-effect
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
        // ADR-017: flip audit.replayed to true on replay to match wire contract
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
      // Refresh response but keep original createdAt to preserve audit timestamp
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
