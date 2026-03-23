import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock env before any other imports
vi.mock('../../env.js', () => ({
  env: {
    GIFT_CARD_API_BASE_URL: 'http://test-upstream.local',
    GIFT_CARD_API_KEY: 'test-key',
    GIFT_CARD_API_SECRET: 'test-secret',
    LOCATION_REFRESH_INTERVAL_HOURS: 24,
  },
}));

// Mock logger to suppress output
vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Must import after mocks are set up
import { refreshLocations, getLocations } from '../data-store.js';

/** Helper: build an upstream API location response page. */
function makePage(
  page: number,
  pages: number,
  result: Array<{
    id: string;
    merchantId: string;
    enabled: boolean;
    latLong: { latitude: string; longitude: string };
    mapPinUrl?: string;
  }>,
): Record<string, unknown> {
  return {
    pagination: { page, pages, perPage: 500, total: result.length },
    result,
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

// Reset the module-level state between tests so the concurrency guard and
// stored locations don't leak between cases.
afterEach(async () => {
  vi.resetModules();
});

describe('refreshLocations', () => {
  it('fetches paginated location data and stores valid locations', async () => {
    const page1 = makePage(1, 2, [
      {
        id: 'loc-1',
        merchantId: 'm-1',
        enabled: true,
        latLong: { latitude: '40.7128', longitude: '-74.006' },
        mapPinUrl: 'http://example.com/pin.png',
      },
      {
        id: 'loc-2',
        merchantId: 'm-2',
        enabled: true,
        latLong: { latitude: '34.0522', longitude: '-118.2437' },
      },
    ]);
    const page2 = makePage(2, 2, [
      {
        id: 'loc-3',
        merchantId: 'm-3',
        enabled: true,
        latLong: { latitude: '41.8781', longitude: '-87.6298' },
      },
    ]);

    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify(page1), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(page2), { status: 200 }));

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

    // Should have fetched two pages
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const firstUrl = mockFetch.mock.calls[0]![0] as string;
    expect(firstUrl).toContain('page=1');
    const secondUrl = mockFetch.mock.calls[1]![0] as string;
    expect(secondUrl).toContain('page=2');
  });

  it('retains previous data when upstream returns an error', async () => {
    // First: load some data
    const page = makePage(1, 1, [
      {
        id: 'loc-1',
        merchantId: 'm-1',
        enabled: true,
        latLong: { latitude: '10', longitude: '20' },
      },
    ]);
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(page), { status: 200 }));
    await refreshLocations();

    const { locations: before } = getLocations();
    expect(before).toHaveLength(1);

    // Second: upstream fails
    mockFetch.mockResolvedValueOnce(new Response('Server error', { status: 500 }));
    await refreshLocations();

    // Data should be unchanged
    const { locations: after } = getLocations();
    expect(after).toHaveLength(1);
    expect(after[0]!.merchantId).toBe('m-1');
  });

  it('skips locations with NaN coordinates', async () => {
    const page = makePage(1, 1, [
      {
        id: 'loc-good',
        merchantId: 'm-1',
        enabled: true,
        latLong: { latitude: '40.0', longitude: '-74.0' },
      },
      {
        id: 'loc-bad-lat',
        merchantId: 'm-2',
        enabled: true,
        latLong: { latitude: 'not-a-number', longitude: '-74.0' },
      },
      {
        id: 'loc-bad-lng',
        merchantId: 'm-3',
        enabled: true,
        latLong: { latitude: '40.0', longitude: '' },
      },
    ]);
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(page), { status: 200 }));

    await refreshLocations();

    const { locations } = getLocations();
    expect(locations).toHaveLength(1);
    expect(locations[0]!.merchantId).toBe('m-1');
  });

  it('skips disabled locations', async () => {
    const page = makePage(1, 1, [
      {
        id: 'loc-enabled',
        merchantId: 'm-1',
        enabled: true,
        latLong: { latitude: '40', longitude: '-74' },
      },
      {
        id: 'loc-disabled',
        merchantId: 'm-2',
        enabled: false,
        latLong: { latitude: '41', longitude: '-75' },
      },
    ]);
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(page), { status: 200 }));

    await refreshLocations();

    const { locations } = getLocations();
    expect(locations).toHaveLength(1);
    expect(locations[0]!.merchantId).toBe('m-1');
  });

  it('guards against concurrent refreshes', async () => {
    // Create a fetch that returns slowly so we can test concurrency
    let resolveFirst!: (value: Response) => void;
    const slowResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });

    const page = makePage(1, 1, [
      {
        id: 'loc-1',
        merchantId: 'm-1',
        enabled: true,
        latLong: { latitude: '40', longitude: '-74' },
      },
    ]);

    mockFetch.mockReturnValueOnce(slowResponse);

    // Start first refresh (will be pending)
    const first = refreshLocations();

    // Start second refresh — should bail out because first is in progress
    const second = refreshLocations();
    await second; // second returns immediately

    // Resolve the first request
    resolveFirst(new Response(JSON.stringify(page), { status: 200 }));
    await first;

    // Only one fetch call should have been made
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
