import { eq, sql } from 'drizzle-orm';
import type { Merchant } from '@loop/shared';
import type { Location } from '../clustering/algorithm.js';
import { db } from '../db/client.js';
import { ctxCatalogSnapshots } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'ctx-catalog-snapshots' });

export type CatalogSnapshotName = 'merchants' | 'locations';

export interface CatalogSnapshot<T> {
  items: T[];
  loadedAt: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isMerchant(v: unknown): v is Merchant {
  return (
    isRecord(v) &&
    typeof v['id'] === 'string' &&
    typeof v['name'] === 'string' &&
    typeof v['enabled'] === 'boolean'
  );
}

function isLocation(v: unknown): v is Location {
  return (
    isRecord(v) &&
    typeof v['merchantId'] === 'string' &&
    (typeof v['mapPinUrl'] === 'string' || v['mapPinUrl'] === null) &&
    typeof v['latitude'] === 'number' &&
    Number.isFinite(v['latitude']) &&
    typeof v['longitude'] === 'number' &&
    Number.isFinite(v['longitude'])
  );
}

function parseSnapshotPayload<T>(name: CatalogSnapshotName, payload: unknown): T[] | null {
  if (!Array.isArray(payload)) return null;
  const valid = name === 'merchants' ? payload.every(isMerchant) : payload.every(isLocation);
  if (!valid) return null;
  return payload as T[];
}

export async function loadCatalogSnapshot<T>(
  name: CatalogSnapshotName,
): Promise<CatalogSnapshot<T> | null> {
  const [row] = await db
    .select({
      payload: ctxCatalogSnapshots.payload,
      loadedAt: ctxCatalogSnapshots.loadedAt,
    })
    .from(ctxCatalogSnapshots)
    .where(eq(ctxCatalogSnapshots.name, name))
    .limit(1);
  if (row === undefined) return null;

  const items = parseSnapshotPayload<T>(name, row.payload);
  if (items === null) {
    log.error({ name }, 'CTX catalog snapshot failed payload validation — ignoring warm-start');
    return null;
  }
  return { items, loadedAt: row.loadedAt.getTime() };
}

export async function saveCatalogSnapshot<T>(args: {
  name: CatalogSnapshotName;
  items: T[];
  loadedAt: Date;
}): Promise<void> {
  await db
    .insert(ctxCatalogSnapshots)
    .values({
      name: args.name,
      payload: args.items,
      itemCount: args.items.length,
      loadedAt: args.loadedAt,
    })
    .onConflictDoUpdate({
      target: ctxCatalogSnapshots.name,
      set: {
        payload: args.items,
        itemCount: args.items.length,
        loadedAt: args.loadedAt,
        updatedAt: sql`NOW()`,
      },
    });
}
