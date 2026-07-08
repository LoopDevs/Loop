import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dbState } = vi.hoisted(() => ({
  dbState: {
    row: undefined as undefined | { payload: unknown; loadedAt: Date },
  },
}));

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (dbState.row === undefined ? [] : [dbState.row]),
        }),
      }),
    }),
  },
}));

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { loadCatalogSnapshot, MAX_WARM_START_AGE_MS } from '../catalog-snapshots.js';

const NOW = 1_780_188_400_000;

const merchant = { id: 'm-1', name: 'Store', enabled: true };

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  dbState.row = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadCatalogSnapshot', () => {
  it('returns a fresh, valid snapshot', async () => {
    dbState.row = { payload: [merchant], loadedAt: new Date(NOW - 60_000) };
    await expect(loadCatalogSnapshot('merchants')).resolves.toEqual({
      items: [merchant],
      loadedAt: NOW - 60_000,
    });
  });

  it('refuses a snapshot older than the warm-start max-age — stale catalogs price real money', async () => {
    dbState.row = {
      payload: [merchant],
      loadedAt: new Date(NOW - MAX_WARM_START_AGE_MS - 1),
    };
    await expect(loadCatalogSnapshot('merchants')).resolves.toBeNull();
  });

  it('accepts a snapshot exactly at the max-age boundary', async () => {
    dbState.row = { payload: [merchant], loadedAt: new Date(NOW - MAX_WARM_START_AGE_MS) };
    await expect(loadCatalogSnapshot('merchants')).resolves.not.toBeNull();
  });

  it('refuses a payload that fails shape validation', async () => {
    dbState.row = { payload: [{ nonsense: true }], loadedAt: new Date(NOW - 1000) };
    await expect(loadCatalogSnapshot('merchants')).resolves.toBeNull();
  });

  it('returns null when no snapshot row exists', async () => {
    await expect(loadCatalogSnapshot('locations')).resolves.toBeNull();
  });
});
