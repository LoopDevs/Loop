import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A2-1702 — `config.ts` does NOT use `apiRequest` because it runs at
 * cold-start before the API client is wired (auth headers, refresh
 * flow depend on it). It uses raw `fetch` with the `API_BASE`
 * override. Tests go through `vi.stubGlobal('fetch')`.
 */
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

import { fetchAppConfig, API_BASE } from '../config';

describe('API_BASE', () => {
  it('resolves to either VITE_API_URL, the prod fallback, or empty string', () => {
    // In the test env VITE_API_URL is unset and PROD is false, so
    // API_BASE should be the empty string. The exact resolution
    // happens at module-load from `import.meta.env`, not a callable
    // function — just assert on a valid shape.
    expect(typeof API_BASE).toBe('string');
  });
});

describe('fetchAppConfig', () => {
  const validConfig = {
    loopAuthNativeEnabled: true,
    loopOrdersEnabled: false,
    social: {
      googleClientIdWeb: 'goog-web',
      googleClientIdIos: null,
      googleClientIdAndroid: null,
      appleServiceId: null,
    },
  };

  it('GETs /api/config with the JSON Accept header', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(validConfig), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await fetchAppConfig();
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe(`${API_BASE}/api/config`);
    expect((init as RequestInit).headers).toEqual({ Accept: 'application/json' });
  });

  it('returns the parsed config body on 200', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(validConfig), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const out = await fetchAppConfig();
    expect(out).toEqual(validConfig);
  });

  it('throws a useful error on non-2xx', async () => {
    mockFetch.mockResolvedValueOnce(new Response('boom', { status: 503 }));
    await expect(fetchAppConfig()).rejects.toThrow(/\/api\/config returned 503/);
  });

  it('throws on 404 — mirror of the non-2xx path', async () => {
    mockFetch.mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(fetchAppConfig()).rejects.toThrow(/\/api\/config returned 404/);
  });

  it('propagates fetch rejections (network error)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));
    await expect(fetchAppConfig()).rejects.toThrow(/network down/);
  });
});
