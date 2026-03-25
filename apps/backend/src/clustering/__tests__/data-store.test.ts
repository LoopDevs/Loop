import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../env.js', () => ({
  env: {
    GIFT_CARD_API_BASE_URL: 'http://test-upstream.local',
    GIFT_CARD_API_KEY: 'test-key',
    GIFT_CARD_API_SECRET: 'test-secret',
    LOCATION_REFRESH_INTERVAL_HOURS: 24,
  },
}));

vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock('../../circuit-breaker.js', () => ({
  upstreamCircuit: {
    fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { refreshLocations, getLocations } from '../data-store.js';

interface MockLocation {
  merchantId: string;
  active: boolean;
  latitude: number;
  longitude: number;
  logoLocation?: string;
  name?: string;
}

/** Helper: build a flat array response matching /dcg/locations shape. */
function makeLocations(items: MockLocation[]): Response {
  return new Response(JSON.stringify(items), { status: 200 });
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(async () => {
  vi.resetModules();
});

describe('refreshLocations', () => {
  it('fetches locations and stores valid ones', async () => {
    mockFetch.mockResolvedValueOnce(
      makeLocations([
        {
          merchantId: 'm-1',
          active: true,
          latitude: 40.7128,
          longitude: -74.006,
          logoLocation: 'http://example.com/pin.png',
        },
        { merchantId: 'm-2', active: true, latitude: 34.0522, longitude: -118.2437 },
        { merchantId: 'm-3', active: true, latitude: 41.8781, longitude: -87.6298 },
      ]),
    );

    await refreshLocations();

    const { locations } = getLocations();
    expect(locations).toHaveLength(3);
    expect(locations[0]).toEqual({
      merchantId: 'm-1',
      mapPinUrl: 'http://example.com/pin.png',
      latitude: 40.7128,
      longitude: -74.006,
    });
    expect(locations[2]).toEqual({
      merchantId: 'm-3',
      mapPinUrl: null,
      latitude: 41.8781,
      longitude: -87.6298,
    });

    // Single fetch (flat array, no pagination)
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain('/dcg/locations');
  });

  it('retains previous data when upstream returns an error', async () => {
    mockFetch.mockResolvedValueOnce(
      makeLocations([{ merchantId: 'm-1', active: true, latitude: 10, longitude: 20 }]),
    );
    await refreshLocations();

    const { locations: before } = getLocations();
    expect(before).toHaveLength(1);

    mockFetch.mockResolvedValueOnce(new Response('Server error', { status: 500 }));
    await refreshLocations();

    const { locations: after } = getLocations();
    expect(after).toHaveLength(1);
    expect(after[0]!.merchantId).toBe('m-1');
  });

  it('skips locations with zero coordinates (online-only)', async () => {
    mockFetch.mockResolvedValueOnce(
      makeLocations([
        { merchantId: 'm-1', active: true, latitude: 40.0, longitude: -74.0 },
        { merchantId: 'm-2', active: true, latitude: 0, longitude: 0 },
      ]),
    );

    await refreshLocations();

    const { locations } = getLocations();
    expect(locations).toHaveLength(1);
    expect(locations[0]!.merchantId).toBe('m-1');
  });

  it('skips inactive locations', async () => {
    mockFetch.mockResolvedValueOnce(
      makeLocations([
        { merchantId: 'm-1', active: true, latitude: 40.0, longitude: -74.0 },
        { merchantId: 'm-2', active: false, latitude: 35.0, longitude: -80.0 },
      ]),
    );

    await refreshLocations();

    const { locations } = getLocations();
    expect(locations).toHaveLength(1);
    expect(locations[0]!.merchantId).toBe('m-1');
  });

  it('prevents concurrent refresh calls', async () => {
    let resolveFirst: ((v: Response) => void) | undefined;
    const slow = new Promise<Response>((r) => {
      resolveFirst = r;
    });
    mockFetch.mockReturnValueOnce(slow);

    const first = refreshLocations();
    const second = refreshLocations(); // should bail immediately

    resolveFirst!(
      makeLocations([{ merchantId: 'm-1', active: true, latitude: 40.0, longitude: -74.0 }]),
    );

    await first;
    await second;

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(getLocations().locations).toHaveLength(1);
  });
});
