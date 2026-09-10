// admin idempotency store — ADR 017; NS-03: replay TTL decoupled from audit retention (this collection doubles as the audit trail)
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

// A2-500: an expired row reads as a miss so replay semantics hold even in the gap between sweeps
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

// A2-500 / NS-03: sweeps by AUDIT RETENTION, not the 24h replay TTL — this collection is the durable admin audit trail (audit-tail.ts reads it)
// a retained row older than 24h is a replay miss at read time, so replay semantics are unchanged
// retentionMs/now are test seams (mirrors runAuthRowPurgeTick)
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

// A5-3: per-target velocity cap — per-IP limits can't bound several IPs under one bearer targeting one victim
// counts committed snapshots only (a replay adds no row); errors propagate so the caller fails closed
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

// upsert idempotently refreshes the stored response; createdAt stays at the first write (audit timestamp)
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
