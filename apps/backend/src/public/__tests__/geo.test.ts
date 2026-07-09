/**
 * `getGeoDbStatus` (go-live-plan §T1-F) — the GeoLite2-Country `.mmdb`
 * staleness/absence signal consumed by `/health` (`health.ts`) and the
 * boot-time diagnostic (`index.ts`). Pins the three-way distinction that
 * matters for not permanently soft-degrading a dev/staging deploy:
 *
 *   - unconfigured (`MAXMIND_GEOLITE2_PATH` unset)        → not stale
 *   - configured but the `.mmdb` fails to open            → stale
 *   - configured, opens, build within the threshold       → not stale
 *   - configured, opens, build past the threshold         → stale
 *
 * Each test re-imports the module fresh (`vi.resetModules`) so the
 * internal reader-open memoization doesn't leak state across scenarios —
 * mirrors the pattern in `well-known/__tests__/deep-link-verification.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { envState, openMock } = vi.hoisted(() => ({
  envState: { MAXMIND_GEOLITE2_PATH: undefined as string | undefined },
  openMock: vi.fn(),
}));

vi.mock('../../env.js', () => ({
  get env() {
    return envState;
  },
}));

vi.mock('maxmind', () => ({
  open: openMock,
}));

// S4-4: `clientIpFor` (imported below from `../../middleware/rate-limit.js`)
// now pulls in `../../middleware/fleet-size.js`, which imports the real
// logger at module scope. This file's `env.js` mock only carries the one
// field `getGeoDbStatus` needs, so the real `logger.ts` would throw at
// import time (`pino()` requires `LOG_LEVEL`/`NODE_ENV`, neither mocked
// here). Mock it out, same as `rate-limit.test.ts` / `health.test.ts` do.
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
  envState.MAXMIND_GEOLITE2_PATH = undefined;
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
    envState.MAXMIND_GEOLITE2_PATH = '/bad/path.mmdb';
    openMock.mockRejectedValue(new Error('ENOENT'));
    const { getGeoDbStatus } = await import('../geo.js');
    const status = await getGeoDbStatus();
    expect(status).toEqual({ available: false, buildEpoch: null, ageDays: null, stale: true });
  });

  it('reports fresh (stale: false) when the build is within the threshold', async () => {
    envState.MAXMIND_GEOLITE2_PATH = '/good/path.mmdb';
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
    envState.MAXMIND_GEOLITE2_PATH = '/good/path.mmdb';
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
    envState.MAXMIND_GEOLITE2_PATH = '/good/path.mmdb';
    openMock.mockResolvedValue({ metadata: { buildEpoch: new Date() } });
    const { getGeoDbStatus } = await import('../geo.js');
    await getGeoDbStatus();
    await getGeoDbStatus();
    expect(openMock).toHaveBeenCalledTimes(1);
  });
});
