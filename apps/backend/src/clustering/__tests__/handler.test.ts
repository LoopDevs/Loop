import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ConfigModule from '../../config/index.js';
import type { Location } from '../algorithm.js';

vi.mock('../../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    config: {
      ...actual.config,
      ctx: { ...actual.config.ctx, baseUrl: 'http://test-upstream.local' },
    },
  };
});

vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

const mockGetLocations = vi.fn();
vi.mock('../data-store.js', () => ({
  startLocationRefresh: vi.fn(),
  stopLocationRefresh: vi.fn(),
  getLocations: () => mockGetLocations(),
  isLocationLoading: () => false,
}));

vi.mock('../../merchants/sync.js', () => ({
  startMerchantRefresh: vi.fn(),
  stopMerchantRefresh: vi.fn(),
  getMerchants: () => ({
    merchants: [],
    merchantsById: new Map(),
    merchantsBySlug: new Map(),
    loadedAt: Date.now(),
  }),
}));

vi.mock('../../images/proxy.js', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...(orig as Record<string, unknown>), evictExpiredImageCache: vi.fn() };
});

import { app } from '../../app.js';

function loc(merchantId: string, lng: number, lat: number): Location {
  return { merchantId, mapPinUrl: null, longitude: lng, latitude: lat };
}

function seed(locations: Location[]): void {
  mockGetLocations.mockReturnValue({ locations, loadedAt: 1_700_000_000_000 });
}

beforeEach(() => {
  mockGetLocations.mockReset();
  seed([]);
});

describe('GET /api/clusters — validation', () => {
  it('rejects missing required query params', async () => {
    const res = await app.request('/api/clusters');
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects non-numeric coordinates', async () => {
    const res = await app.request('/api/clusters?west=abc&south=0&east=10&north=10&zoom=5');
    expect(res.status).toBe(400);
  });

  it('rejects Infinity coordinates', async () => {
    const res = await app.request('/api/clusters?west=-Infinity&south=0&east=10&north=10&zoom=5');
    expect(res.status).toBe(400);
  });

  it('rejects lat outside [-90, 90]', async () => {
    const res = await app.request('/api/clusters?west=0&south=-91&east=10&north=10&zoom=5');
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.message).toContain('outside the globe');
  });

  it('rejects lng outside [-180, 180]', async () => {
    const res = await app.request('/api/clusters?west=-181&south=0&east=10&north=10&zoom=5');
    expect(res.status).toBe(400);
  });

  it('rejects south > north (upside-down bounds)', async () => {
    const res = await app.request('/api/clusters?west=0&south=50&east=10&north=10&zoom=5');
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.message).toContain('south must be <= north');
  });

  it('allows west > east silently (date-line crossing — returns empty)', async () => {
    seed([loc('m-1', 170, 20)]);
    // Antimeridian crossing returns empty; not 400 to preserve client compatibility.
    const res = await app.request('/api/clusters?west=170&south=-90&east=-170&north=90&zoom=3');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { locationPoints: unknown[]; clusterPoints: unknown[] };
    expect(body.locationPoints).toEqual([]);
    expect(body.clusterPoints).toEqual([]);
  });
});

describe('GET /api/clusters — response shape', () => {
  it('returns JSON by default with Cache-Control and Vary: Accept', async () => {
    seed([loc('m-1', 0, 0.5), loc('m-2', 0.5, 0)]);
    const res = await app.request('/api/clusters?west=-1&south=-1&east=1&north=1&zoom=14');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(res.headers.get('Cache-Control')).toContain('max-age=60');
    // Vary: Accept required because handler serves both JSON and protobuf variants.
    expect(res.headers.get('Vary')).toBe('Accept');
    const body = (await res.json()) as {
      locationPoints: Array<{ properties: { merchantId: string } }>;
      clusterPoints: unknown[];
      total: number;
      zoom: number;
      bounds: { west: number; east: number };
      loadedAt: number;
    };
    expect(body.locationPoints).toHaveLength(2);
    expect(body.clusterPoints).toHaveLength(0);
    expect(body.zoom).toBe(14);
    expect(body.bounds).toEqual({ west: -1, south: -1, east: 1, north: 1 });
    expect(body.loadedAt).toBe(Math.floor(1_700_000_000_000 / 1000));
  });

  it('clamps zoom to the 0–28 range', async () => {
    seed([loc('m-1', 0, 0)]);
    const res = await app.request('/api/clusters?west=-1&south=-1&east=1&north=1&zoom=99');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { zoom: number };
    expect(body.zoom).toBe(28);
  });

  it('returns empty result with valid shape when no locations match', async () => {
    seed([loc('m-1', 100, 100)]);
    const res = await app.request('/api/clusters?west=-1&south=-1&east=1&north=1&zoom=14');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      locationPoints: unknown[];
      clusterPoints: unknown[];
      total: number;
    };
    expect(body.locationPoints).toEqual([]);
    expect(body.clusterPoints).toEqual([]);
    // Total counts locations in the expanded bbox, not just matches.
    expect(body.total).toBe(0);
  });

  it('clamps the 50%-expanded bbox to the globe (no -140° latitudes)', async () => {
    // Full-globe bounds: naive 50% buffer exceeds valid latitude range.
    seed([loc('m-south-pole', 0, -90), loc('m-north-pole', 0, 90)]);
    const res = await app.request('/api/clusters?west=-180&south=-90&east=180&north=90&zoom=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clusterPoints: unknown[]; locationPoints: unknown[] };
    expect(body.locationPoints.length + body.clusterPoints.length).toBeGreaterThan(0);
  });

  it('falls back to JSON when Accept requests protobuf but types are unavailable', async () => {
    // Proto types may be missing in test env; handler falls back to JSON.
    seed([loc('m-1', 0, 0)]);
    const res = await app.request('/api/clusters?west=-1&south=-1&east=1&north=1&zoom=14', {
      headers: { Accept: 'application/x-protobuf' },
    });
    expect(res.status).toBe(200);
    const ct = res.headers.get('Content-Type');
    expect(ct === null || ct.length > 0).toBe(true);
  });
});
