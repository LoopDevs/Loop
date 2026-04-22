/**
 * Admin idempotency store (ADR 017).
 *
 * Stores `(admin_user_id, key) → response snapshot` for 24h. On a
 * repeat POST with the same pair, the stored snapshot is replayed
 * verbatim so a double-click or a network-retry cannot cause
 * double side-effects (double-credit, double-payout-retry, etc.).
 *
 * Two entry points:
 *   - `lookupIdempotencyKey` — called BEFORE the write. Returns the
 *     prior snapshot if one exists; handler replays it and exits.
 *   - `storeIdempotencyKey` — called AFTER a successful write, with
 *     the status + body the handler is about to return.
 *
 * Missing header is rejected at the handler edge with a 400 — it is
 * NOT the store's responsibility to fabricate a key, because then a
 * retry would look like a new request and side-effects would double.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { adminIdempotencyKeys } from '../db/schema.js';

export const IDEMPOTENCY_KEY_MIN = 16;
export const IDEMPOTENCY_KEY_MAX = 128;

export interface IdempotencySnapshot {
  status: number;
  body: Record<string, unknown>;
  createdAt: Date;
}

export function validateIdempotencyKey(key: string | undefined): key is string {
  if (key === undefined) return false;
  return key.length >= IDEMPOTENCY_KEY_MIN && key.length <= IDEMPOTENCY_KEY_MAX;
}

/**
 * Fetch a prior snapshot for the given (adminUserId, key). Returns
 * null on miss. The caller is responsible for the 24h TTL check —
 * we return whatever the row has and let the handler decide; most
 * handlers just always replay what exists since an opaque key from
 * the client should only ever be used once.
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
