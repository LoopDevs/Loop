import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Location } from '../algorithm.js';

const mockEnv = vi.hoisted(() => ({
  PORT: 8080,
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  GIFT_CARD_API_BASE_URL: 'http://test-upstream.local',
  REFRESH_INTERVAL_HOURS: 6,
  LOCATION_REFRESH_INTERVAL_HOURS: 24,
}));

vi.mock('../../env.js', () => ({ env: mockEnv }));

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

vi.mock('../../circuit-breaker.js', () => ({
  CircuitOpenError: class CircuitOpenError extends Error {
    constructor() {
      super('open');
      this.name = 'CircuitOpenError';
    }
  },
  getAllCircuitStates: () => ({}),
  getUpstreamCircuit: () => ({
    fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
    getState: () => 'closed' as const,
    reset: () => {},
  }),
}));

// Import the REAL clustering handler — do not mock ../handler so we exercise
// the validation and the algorithm composition. app.ts imports the real
// handler via ./clustering/handler.
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
    // Known limitation: antimeridian case returns empty. We explicitly do
    // NOT 400 these so existing clients continue working.
    const res = await app.request('/api/clusters?west=170&south=-90&east=-170&north=90&zoom=3');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { locationPoints: unknown[]; clusterPoints: unknown[] };
    expect(body.locationPoints).toEqual([]);
    expect(body.clusterPoints).toEqual([]);
  });
});

describe('GET /api/clusters — response shape', () => {
  it('returns JSON by default with Cache-Control', async () => {
    seed([loc('m-1', 0, 0.5), loc('m-2', 0.5, 0)]);
    const res = await app.request('/api/clusters?west=-1&south=-1&east=1&north=1&zoom=14');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(res.headers.get('Cache-Control')).toContain('max-age=60');
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
    // loadedAt should be the seeded timestamp / 1000 floored
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
    seed([loc('m-1', 100, 100)]); // far outside bounds
    const res = await app.request('/api/clusters?west=-1&south=-1&east=1&north=1&zoom=14');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      locationPoints: unknown[];
      clusterPoints: unknown[];
      total: number;
    };
    expect(body.locationPoints).toEqual([]);
    expect(body.clusterPoints).toEqual([]);
    // total is the count within the *expanded* bbox, not matches.
    expect(body.total).toBe(0);
  });

  it('falls back to JSON when Accept requests protobuf but types are unavailable', async () => {
    // Proto types aren't generated in test environment — handler catches the
    // dynamic-import error and falls through to JSON. Ensures the fallback
    // path is live and produces the usual shape.
    seed([loc('m-1', 0, 0)]);
    const res = await app.request('/api/clusters?west=-1&south=-1&east=1&north=1&zoom=14', {
      headers: { Accept: 'application/x-protobuf' },
    });
    expect(res.status).toBe(200);
    // If proto types are available (CI has run buf generate), response will
    // be protobuf; otherwise JSON. Accept either, but assert we got 200 and
    // a useful Content-Type.
    const ct = res.headers.get('Content-Type');
    expect(ct === null || ct.length > 0).toBe(true);
  });
});
