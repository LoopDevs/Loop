import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ConfigModule from '../../config/index.js';
import type { Context } from 'hono';
import type { LoopAuthContext } from '../../auth/handler.js';

const { configState } = vi.hoisted(() => ({
  configState: { nativeAuthEnabled: true },
}));

vi.mock('../../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    get config() {
      return {
        ...actual.config,
        auth: {
          ...actual.config.auth,
          native: { ...actual.config.auth.native, enabled: configState.nativeAuthEnabled },
        },
      };
    },
  };
});

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { dbState, ctxState, mockFetchAndTransform, mockValidateUrl } = vi.hoisted(() => ({
  dbState: { row: undefined as unknown },
  ctxState: { card: null as unknown, cardThrows: false },
  mockFetchAndTransform: vi.fn(),
  mockValidateUrl: vi.fn<() => Promise<string | null>>(),
}));

vi.mock('../../db/client.js', () => ({
  db: {
    collection: vi.fn(() => ({
      findOne: vi.fn(async () => dbState.row ?? null),
    })),
  },
}));

vi.mock('../ctx-order.js', () => ({
  fetchCtxCardAsOperator: vi.fn(async () => {
    if (ctxState.cardThrows) throw new Error('ctx down');
    return ctxState.card;
  }),
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

vi.mock('../../images/ssrf-guard.js', () => ({
  validateResolvedImageUrl: mockValidateUrl,
}));

import { loopOrderBarcodeImageHandler } from '../loop-barcode-image-handler.js';

const LOOP_AUTH: LoopAuthContext = {
  kind: 'loop',
  userId: 'user-uuid',
  email: 'a@b.com',
  bearerToken: 'loop-access',
};

function makeContext(args: {
  id?: string;
  auth?: LoopAuthContext | { kind: 'ctx' };
  query?: Record<string, string>;
}): Context {
  const vars = new Map<string, unknown>();
  if (args.auth !== undefined) vars.set('auth', args.auth);
  return {
    req: {
      param: (name: string) => (name === 'id' ? args.id : undefined),
      query: (name: string) => args.query?.[name],
    },
    get: (key: string) => vars.get(key),
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  } as unknown as Context;
}

function fulfilledRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'o-1',
    userId: 'user-uuid',
    state: 'fulfilled',
    ctxOrderId: 'ctx-1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  configState.nativeAuthEnabled = true;
  dbState.row = undefined;
  ctxState.card = { id: 'ctx-1', barcodeUrl: 'https://ctx.test/gift-cards/ctx-1/barcode?token=t' };
  ctxState.cardThrows = false;
  mockValidateUrl.mockResolvedValue(null);
  mockFetchAndTransform.mockResolvedValue({
    ok: true,
    data: new Uint8Array([0xff, 0xd8]),
    mimeType: 'image/jpeg',
  });
});

describe('loopOrderBarcodeImageHandler', () => {
  it('returns 404 when native auth is disabled', async () => {
    configState.nativeAuthEnabled = false;
    const res = await loopOrderBarcodeImageHandler(makeContext({ id: 'o-1', auth: LOOP_AUTH }));
    expect(res.status).toBe(404);
  });

  it('returns 401 for a non-Loop auth context', async () => {
    const res = await loopOrderBarcodeImageHandler(
      makeContext({ id: 'o-1', auth: { kind: 'ctx' } }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 when the order does not belong to the caller', async () => {
    dbState.row = undefined;
    const res = await loopOrderBarcodeImageHandler(makeContext({ id: 'o-1', auth: LOOP_AUTH }));
    expect(res.status).toBe(404);
    expect(mockFetchAndTransform).not.toHaveBeenCalled();
  });

  it('returns 404 for an order that is not yet fulfilled', async () => {
    dbState.row = fulfilledRow({ state: 'paid' });
    const res = await loopOrderBarcodeImageHandler(makeContext({ id: 'o-1', auth: LOOP_AUTH }));
    expect(res.status).toBe(404);
    expect(mockFetchAndTransform).not.toHaveBeenCalled();
  });

  it('returns 404 when the CTX card carries no barcodeUrl', async () => {
    dbState.row = fulfilledRow();
    ctxState.card = { id: 'ctx-1', number: '123' };
    const res = await loopOrderBarcodeImageHandler(makeContext({ id: 'o-1', auth: LOOP_AUTH }));
    expect(res.status).toBe(404);
    expect(mockFetchAndTransform).not.toHaveBeenCalled();
  });

  it('proxies the CTX barcode image as a private JPEG response', async () => {
    dbState.row = fulfilledRow();
    const res = await loopOrderBarcodeImageHandler(makeContext({ id: 'o-1', auth: LOOP_AUTH }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('Cache-Control')).toContain('private');
    expect(mockValidateUrl).toHaveBeenCalledWith(
      'https://ctx.test/gift-cards/ctx-1/barcode?token=t',
    );
    expect(mockFetchAndTransform).toHaveBeenCalledWith(
      'https://ctx.test/gift-cards/ctx-1/barcode?token=t',
      expect.objectContaining({ width: 640, quality: 80, forceJpeg: true }),
    );
  });

  it('honours width and quality query params within clamps', async () => {
    dbState.row = fulfilledRow();
    await loopOrderBarcodeImageHandler(
      makeContext({ id: 'o-1', auth: LOOP_AUTH, query: { width: '9999', quality: '500' } }),
    );
    expect(mockFetchAndTransform).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ width: 2000, quality: 100 }),
    );
  });

  it('returns 502 when the SSRF guard rejects the resolved URL', async () => {
    dbState.row = fulfilledRow();
    mockValidateUrl.mockResolvedValue('private ip');
    const res = await loopOrderBarcodeImageHandler(makeContext({ id: 'o-1', auth: LOOP_AUTH }));
    expect(res.status).toBe(502);
    expect(mockFetchAndTransform).not.toHaveBeenCalled();
  });

  it('returns 502 when the CTX card read fails', async () => {
    dbState.row = fulfilledRow();
    ctxState.cardThrows = true;
    const res = await loopOrderBarcodeImageHandler(makeContext({ id: 'o-1', auth: LOOP_AUTH }));
    expect(res.status).toBe(502);
  });

  it('relays the image proxy failure status', async () => {
    dbState.row = fulfilledRow();
    mockFetchAndTransform.mockResolvedValue({
      ok: false,
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'too big',
    });
    const res = await loopOrderBarcodeImageHandler(makeContext({ id: 'o-1', auth: LOOP_AUTH }));
    expect(res.status).toBe(413);
  });
});
