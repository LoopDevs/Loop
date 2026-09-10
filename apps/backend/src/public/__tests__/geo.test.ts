// getGeoDbStatus tests — S4-4
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ConfigModule from '../../config/index.js';

const { geoipState, openMock } = vi.hoisted(() => ({
  geoipState: { databasePath: undefined as string | undefined },
  openMock: vi.fn(),
}));

vi.mock('../../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    get config() {
      return { ...actual.config, catalog: { ...actual.config.catalog, geoip: geoipState } };
    },
  };
});

vi.mock('maxmind', () => ({
  open: openMock,
}));

// S4-4: mock logger to prevent real pino instance creation via transitive import
vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

beforeEach(() => {
  vi.resetModules();
  geoipState.databasePath = undefined;
  openMock.mockReset();
});

describe('getGeoDbStatus', () => {
  it('reports unconfigured (available: false, stale: false) when MAXMIND_GEOLITE2_PATH is unset', async () => {
    const { getGeoDbStatus } = await import('../geo.js');
    const status = await getGeoDbStatus();
    expect(status).toEqual({ available: false, buildEpoch: null, ageDays: null, stale: false });
    expect(openMock).not.toHaveBeenCalled();
  });

  it('reports misconfigured (available: false, stale: true) when the path is set but open() rejects', async () => {
    geoipState.databasePath = '/bad/path.mmdb';
    openMock.mockRejectedValue(new Error('ENOENT'));
    const { getGeoDbStatus } = await import('../geo.js');
    const status = await getGeoDbStatus();
    expect(status).toEqual({ available: false, buildEpoch: null, ageDays: null, stale: true });
  });

  it('reports fresh (stale: false) when the build is within the threshold', async () => {
    geoipState.databasePath = '/good/path.mmdb';
    const buildEpoch = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    openMock.mockResolvedValue({ metadata: { buildEpoch } });
    const { getGeoDbStatus } = await import('../geo.js');
    const status = await getGeoDbStatus();
    expect(status.available).toBe(true);
    expect(status.stale).toBe(false);
    expect(status.ageDays).toBe(5);
    expect(status.buildEpoch).toBe(buildEpoch.toISOString());
  });

  it('reports stale when the build is older than GEO_DB_STALE_AFTER_DAYS', async () => {
    geoipState.databasePath = '/good/path.mmdb';
    const buildEpoch = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    openMock.mockResolvedValue({ metadata: { buildEpoch } });
    const { getGeoDbStatus, GEO_DB_STALE_AFTER_DAYS } = await import('../geo.js');
    expect(GEO_DB_STALE_AFTER_DAYS).toBe(45);
    const status = await getGeoDbStatus();
    expect(status.available).toBe(true);
    expect(status.stale).toBe(true);
    expect(status.ageDays).toBe(100);
  });

  it('memoizes the reader open — a second call does not re-open the db', async () => {
    geoipState.databasePath = '/good/path.mmdb';
    openMock.mockResolvedValue({ metadata: { buildEpoch: new Date() } });
    const { getGeoDbStatus } = await import('../geo.js');
    await getGeoDbStatus();
    await getGeoDbStatus();
    expect(openMock).toHaveBeenCalledTimes(1);
  });
});
