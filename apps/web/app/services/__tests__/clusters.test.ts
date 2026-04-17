import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('~/services/config', () => ({ API_BASE: 'http://test-api' }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { fetchClusters } from '../clusters';

describe('clusters service', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const defaultParams = { west: -130, south: 24, east: -65, north: 50, zoom: 5 };

  it('fetches clusters with correct URL and params', async () => {
    const mockResponse = {
      locationPoints: [],
      clusterPoints: [],
      total: 0,
      zoom: 5,
      loadedAt: 1234567890,
      bounds: { west: -130, south: 24, east: -65, north: 50 },
    };
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await fetchClusters(defaultParams);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain('http://test-api/api/clusters?');
    expect(url).toContain('west=-130');
    expect(url).toContain('south=24');
    expect(url).toContain('east=-65');
    expect(url).toContain('north=50');
    expect(url).toContain('zoom=5');
  });

  it('sends Accept: application/x-protobuf header', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          locationPoints: [],
          clusterPoints: [],
          total: 0,
          zoom: 5,
          loadedAt: 0,
          bounds: {},
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    await fetchClusters(defaultParams);

    const init = mockFetch.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Accept).toBe('application/x-protobuf');
  });

  it('returns parsed JSON response when content-type is JSON', async () => {
    const mockResponse = {
      locationPoints: [{ type: 'Feature', properties: { cluster: false } }],
      clusterPoints: [],
      total: 1,
      zoom: 10,
      loadedAt: 1234567890,
      bounds: { west: -1, south: -1, east: 1, north: 1 },
    };
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await fetchClusters({ west: -1, south: -1, east: 1, north: 1, zoom: 10 });
    expect(result.total).toBe(1);
    expect(result.locationPoints).toHaveLength(1);
  });

  it('throws ApiException on non-ok response with JSON error body', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ code: 'INTERNAL_ERROR', message: 'boom' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(fetchClusters(defaultParams)).rejects.toMatchObject({
      name: 'ApiException',
      status: 500,
      code: 'INTERNAL_ERROR',
    });
  });

  it('throws ApiException with UPSTREAM_ERROR when body is not JSON', async () => {
    mockFetch.mockResolvedValue(new Response('Not Found', { status: 404 }));
    await expect(fetchClusters(defaultParams)).rejects.toMatchObject({
      name: 'ApiException',
      status: 404,
      code: 'UPSTREAM_ERROR',
    });
  });

  it('normalizes wrong-shape JSON error to UPSTREAM_ERROR', async () => {
    // A gateway or misconfigured proxy returning JSON but without our
    // `{code, message}` shape must not produce `ApiException { code: undefined }` —
    // that would break every `switch (err.code)` downstream. Mirrors the
    // normalization in api-client.ts.
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ foo: 'bar' }), {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(fetchClusters(defaultParams)).rejects.toMatchObject({
      status: 502,
      code: 'UPSTREAM_ERROR',
      message: 'Bad Gateway',
    });
  });

  it('aborts the in-flight fetch when the caller signal aborts', async () => {
    // A map component unmounting mid-fetch should be able to cancel rather
    // than wait 30s. The composed signal in fetchClusters must surface the
    // caller abort as a TIMEOUT-coded ApiException (the component doesn't
    // distinguish abort from timeout semantically).
    const controller = new AbortController();
    mockFetch.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const promise = fetchClusters(defaultParams, controller.signal).catch((e) => e);
    controller.abort();
    const err = (await promise) as { status: number; code: string };
    expect(err.status).toBe(0);
    expect(err.code).toBe('TIMEOUT');
  });
});
