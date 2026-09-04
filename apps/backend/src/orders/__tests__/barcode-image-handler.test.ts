import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
}));

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: { GIFT_CARD_API_BASE_URL: 'http://ctx.test', NODE_ENV: 'test' } as Record<
    string,
    unknown
  >,
}));
vi.mock('../../env.js', () => ({ env: mockEnv }));

// The caller's upstream CTX credentials — null simulates a loop-native
// user with no CTX mapping.
const { mockUpstreamHeaders } = vi.hoisted(() => ({
  mockUpstreamHeaders: vi.fn<() => Promise<Record<string, string> | null>>(),
}));
vi.mock('../handler-shared.js', () => ({
  upstreamHeaders: mockUpstreamHeaders,
}));

vi.mock('../../circuit-breaker.js', () => ({
  CircuitOpenError: class CircuitOpenError extends Error {},
  getUpstreamCircuit: () => ({
    fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
  }),
}));

// The image transport/transform layer is proven in images/__tests__ —
// here it's mocked so the handler's resolution + authz mapping is what's
// under test.
const { mockFetchAndTransform } = vi.hoisted(() => ({
  mockFetchAndTransform: vi.fn(),
}));
vi.mock('../../images/proxy.js', () => ({
  fetchAndTransformImage: mockFetchAndTransform,
  imageResponse: (data: Uint8Array, mimeType: string, mode: string) =>
    new Response(data, {
      headers: {
        'Content-Type': mimeType,
        'Cache-Control': mode === 'private' ? 'private, no-store' : 'public',
      },
    }),
  clampDimension: (v: number) => (isNaN(v) || v <= 0 ? 0 : Math.min(v, 2000)),
  clampQuality: (v: number) => (isNaN(v) ? 80 : Math.max(1, Math.min(v, 100))),
}));

const { mockValidateUrl } = vi.hoisted(() => ({
  mockValidateUrl: vi.fn<() => Promise<string | null>>(),
}));
vi.mock('../../images/ssrf-guard.js', () => ({
  validateResolvedImageUrl: mockValidateUrl,
}));

import { orderBarcodeImageHandler } from '../barcode-image-handler.js';

const fetchSpy = vi.fn<typeof globalThis.fetch>();
vi.stubGlobal('fetch', fetchSpy);

function makeApp(): Hono {
  const app = new Hono();
  app.get('/api/orders/:id/barcode-image', orderBarcodeImageHandler);
  return app;
}

function ctxOrder(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      id: 'ord-1',
      status: 'fulfilled',
      barcodeUrl: 'http://ctx.test/bc.png',
      ...overrides,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpstreamHeaders.mockResolvedValue({ Authorization: 'Bearer op-token' });
  mockValidateUrl.mockResolvedValue(null);
  mockFetchAndTransform.mockResolvedValue({
    ok: true,
    data: new Uint8Array([0xff, 0xd8]),
    mimeType: 'image/jpeg',
  });
});

describe('orderBarcodeImageHandler', () => {
  it('rejects a malformed order id with 400', async () => {
    const res = await makeApp().request('/api/orders/../etc/barcode-image');
    expect([400, 404]).toContain(res.status); // traversal never reaches CTX
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('404s when the caller has no CTX identity (loop-native user)', async () => {
    mockUpstreamHeaders.mockResolvedValue(null);
    const res = await makeApp().request('/api/orders/ord-1/barcode-image');
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps a CTX 404 (foreign or unknown order) to 404', async () => {
    fetchSpy.mockResolvedValue(new Response('nope', { status: 404 }));
    const res = await makeApp().request('/api/orders/ord-1/barcode-image');
    expect(res.status).toBe(404);
  });

  it('404s when the order has no barcode image field', async () => {
    fetchSpy.mockResolvedValue(ctxOrder({ barcodeUrl: undefined }));
    const res = await makeApp().request('/api/orders/ord-1/barcode-image');
    expect(res.status).toBe(404);
    expect(mockFetchAndTransform).not.toHaveBeenCalled();
  });

  it('resolves the CTX barcode URL server-side and serves private JPEG bytes', async () => {
    fetchSpy.mockResolvedValue(ctxOrder());
    const res = await makeApp().request('/api/orders/ord-1/barcode-image?width=320');

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    // CTX order fetched with the caller's upstream credentials.
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('http://ctx.test/gift-cards/ord-1');
    // The resolved URL — never a client-supplied one — is what gets
    // fetched, flattened to JPEG.
    expect(mockFetchAndTransform).toHaveBeenCalledWith(
      'http://ctx.test/bc.png',
      expect.objectContaining({ width: 320, forceJpeg: true }),
    );
  });

  it('502s when the resolved barcode URL fails validation', async () => {
    fetchSpy.mockResolvedValue(ctxOrder());
    mockValidateUrl.mockResolvedValue('Private and loopback addresses are not allowed');
    const res = await makeApp().request('/api/orders/ord-1/barcode-image');
    expect(res.status).toBe(502);
    expect(mockFetchAndTransform).not.toHaveBeenCalled();
  });
});
