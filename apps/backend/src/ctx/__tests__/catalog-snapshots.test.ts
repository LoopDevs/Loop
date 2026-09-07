import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { db, __resetDbForTests } from '../../db/client.js';
import {
  loadCatalogSnapshot,
  saveCatalogSnapshot,
  MAX_WARM_START_AGE_MS,
} from '../catalog-snapshots.js';

/**
 * R3-3 warm-start snapshots (last-good CTX catalog), against the real
 * in-memory document store: freshness gate, payload validation, and
 * the save→load round trip through the upserting writer.
 */
const NOW = 1_780_188_400_000;

const merchant = { id: 'm-1', name: 'Store', enabled: true };

/** Seeds a snapshot doc directly (bypassing the writer under test). */
async function seedSnapshot(
  name: 'merchants' | 'locations',
  payload: unknown[],
  loadedAt: Date,
): Promise<void> {
  await db.collection('ctx_catalog_snapshots').insertOne({
    name,
    payload,
    itemCount: payload.length,
    loadedAt,
    updatedAt: loadedAt,
  });
}

beforeEach(() => {
  __resetDbForTests();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadCatalogSnapshot', () => {
  it('returns a fresh, valid snapshot', async () => {
    await seedSnapshot('merchants', [merchant], new Date(NOW - 60_000));
    await expect(loadCatalogSnapshot('merchants')).resolves.toEqual({
      items: [merchant],
      loadedAt: NOW - 60_000,
    });
  });

  it('refuses a snapshot older than the warm-start max-age — stale catalogs price real money', async () => {
    await seedSnapshot('merchants', [merchant], new Date(NOW - MAX_WARM_START_AGE_MS - 1));
    await expect(loadCatalogSnapshot('merchants')).resolves.toBeNull();
  });

  it('accepts a snapshot exactly at the max-age boundary', async () => {
    await seedSnapshot('merchants', [merchant], new Date(NOW - MAX_WARM_START_AGE_MS));
    await expect(loadCatalogSnapshot('merchants')).resolves.not.toBeNull();
  });

  it('refuses a payload that fails shape validation', async () => {
    await seedSnapshot('merchants', [{ nonsense: true }], new Date(NOW - 1000));
    await expect(loadCatalogSnapshot('merchants')).resolves.toBeNull();
  });

  it('returns null when no snapshot row exists', async () => {
    await expect(loadCatalogSnapshot('locations')).resolves.toBeNull();
  });
});

describe('saveCatalogSnapshot', () => {
  it('round-trips through loadCatalogSnapshot', async () => {
    await saveCatalogSnapshot({
      name: 'merchants',
      items: [merchant],
      loadedAt: new Date(NOW - 5000),
    });
    await expect(loadCatalogSnapshot('merchants')).resolves.toEqual({
      items: [merchant],
      loadedAt: NOW - 5000,
    });
  });

  it('upserts — a re-save replaces the prior snapshot instead of duplicating', async () => {
    await saveCatalogSnapshot({
      name: 'merchants',
      items: [merchant],
      loadedAt: new Date(NOW - 9000),
    });
    const newer = { id: 'm-2', name: 'Newer Store', enabled: true };
    await saveCatalogSnapshot({
      name: 'merchants',
      items: [newer],
      loadedAt: new Date(NOW - 1000),
    });
    expect(await db.collection('ctx_catalog_snapshots').count({ name: 'merchants' })).toBe(1);
    await expect(loadCatalogSnapshot('merchants')).resolves.toEqual({
      items: [newer],
      loadedAt: NOW - 1000,
    });
  });
});
