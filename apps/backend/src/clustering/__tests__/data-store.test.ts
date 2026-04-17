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
  id: string;
  merchantId: string;
  enabled: boolean;
  latLong: { latitude: string; longitude: string };
  mapPinUrl?: string;
}

/** Helper: build a paginated /locations response. */
function makePage(page: number, pages: number, result: MockLocation[]): Response {
  return new Response(
    JSON.stringify({
      pagination: { page, pages, perPage: 1000, total: result.length * pages },
      result,
    }),
    { status: 200 },
  );
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(async () => {
  vi.resetModules();
});

describe('refreshLocations', () => {
  it('fetches paginated locations and stores valid ones', async () => {
    mockFetch
      .mockResolvedValueOnce(
        makePage(1, 2, [
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
        ]),
      )
      .mockResolvedValueOnce(
        makePage(2, 2, [
          {
            id: 'loc-3',
            merchantId: 'm-3',
            enabled: true,
            latLong: { latitude: '41.8781', longitude: '-87.6298' },
          },
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

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const firstUrl = mockFetch.mock.calls[0]![0] as string;
    expect(firstUrl).toContain('/locations');
    expect(firstUrl).toContain('page=1');
  });

  it('retains previous data when upstream returns an error', async () => {
    mockFetch.mockResolvedValueOnce(
      makePage(1, 1, [
        {
          id: 'loc-1',
          merchantId: 'm-1',
          enabled: true,
          latLong: { latitude: '10', longitude: '20' },
        },
      ]),
    );
    await refreshLocations();
    expect(getLocations().locations).toHaveLength(1);

    mockFetch.mockResolvedValueOnce(new Response('Server error', { status: 500 }));
    await refreshLocations();

    expect(getLocations().locations).toHaveLength(1);
    expect(getLocations().locations[0]!.merchantId).toBe('m-1');
  });

  it('skips locations with zero coordinates', async () => {
    mockFetch.mockResolvedValueOnce(
      makePage(1, 1, [
        {
          id: 'loc-1',
          merchantId: 'm-1',
          enabled: true,
          latLong: { latitude: '40.0', longitude: '-74.0' },
        },
        {
          id: 'loc-2',
          merchantId: 'm-2',
          enabled: true,
          latLong: { latitude: '0', longitude: '0' },
        },
      ]),
    );

    await refreshLocations();
    expect(getLocations().locations).toHaveLength(1);
    expect(getLocations().locations[0]!.merchantId).toBe('m-1');
  });

  it('skips disabled locations', async () => {
    mockFetch.mockResolvedValueOnce(
      makePage(1, 1, [
        {
          id: 'loc-1',
          merchantId: 'm-1',
          enabled: true,
          latLong: { latitude: '40.0', longitude: '-74.0' },
        },
        {
          id: 'loc-2',
          merchantId: 'm-2',
          enabled: false,
          latLong: { latitude: '35.0', longitude: '-80.0' },
        },
      ]),
    );

    await refreshLocations();
    expect(getLocations().locations).toHaveLength(1);
    expect(getLocations().locations[0]!.merchantId).toBe('m-1');
  });

  it('prevents concurrent refresh calls', async () => {
    let resolveFirst: ((v: Response) => void) | undefined;
    const slow = new Promise<Response>((r) => {
      resolveFirst = r;
    });
    mockFetch.mockReturnValueOnce(slow);

    const first = refreshLocations();
    const second = refreshLocations();

    resolveFirst!(
      makePage(1, 1, [
        {
          id: 'loc-1',
          merchantId: 'm-1',
          enabled: true,
          latLong: { latitude: '40.0', longitude: '-74.0' },
        },
      ]),
    );

    await first;
    await second;

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(getLocations().locations).toHaveLength(1);
  });

  it('skips individual malformed locations without poisoning the page', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          pagination: { page: 1, pages: 1, perPage: 1000, total: 4 },
          result: [
            {
              id: 'good-1',
              merchantId: 'm-1',
              enabled: true,
              latLong: { latitude: '40.0', longitude: '-74.0' },
            },
            // missing merchantId → rejected by Zod
            { id: 'bad-1', enabled: true, latLong: { latitude: '40', longitude: '-74' } },
            // missing latLong entirely → rejected by Zod
            { id: 'bad-2', merchantId: 'm-2', enabled: true },
            {
              id: 'good-2',
              merchantId: 'm-3',
              enabled: true,
              latLong: { latitude: '34.0', longitude: '-118.0' },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    await refreshLocations();

    const ids = getLocations().locations.map((l) => l.merchantId);
    expect(ids).toContain('m-1');
    expect(ids).toContain('m-3');
    expect(ids).not.toContain('m-2');
  });

  it('rejects locations with out-of-range coordinates', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          pagination: { page: 1, pages: 1, perPage: 1000, total: 4 },
          result: [
            {
              id: 'ok',
              merchantId: 'm-ok',
              enabled: true,
              latLong: { latitude: '40', longitude: '-74' },
            },
            {
              id: 'lat-too-high',
              merchantId: 'm-lat',
              enabled: true,
              latLong: { latitude: '91', longitude: '0' },
            },
            {
              id: 'lng-too-low',
              merchantId: 'm-lng',
              enabled: true,
              latLong: { latitude: '0', longitude: '-181' },
            },
            {
              id: 'null-island',
              merchantId: 'm-zero',
              enabled: true,
              latLong: { latitude: '0', longitude: '0' },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    await refreshLocations();

    const ids = getLocations().locations.map((l) => l.merchantId);
    expect(ids).toEqual(['m-ok']);
  });

  it('rejects an upstream response that is missing pagination', async () => {
    // Previously this would have crashed on data.pagination.pages access.
    // Now the Zod validator rejects cleanly and the catch preserves previous data.
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }));

    await refreshLocations();

    // No throw propagated; store retains whatever it had before.
    expect(Array.isArray(getLocations().locations)).toBe(true);
  });
});
