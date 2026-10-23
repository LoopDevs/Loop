import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ConfigModule from '../../config/index.js';
import type * as RefreshTokensModule from '../refresh-tokens.js';

const { configState } = vi.hoisted(() => ({
  configState: { jwtCurrent: undefined as string | undefined },
}));

vi.mock('../../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    get config() {
      return {
        ...actual.config,
        ctx: { ...actual.config.ctx, baseUrl: 'http://test-upstream.local' },
        // Audit A-023 / FT-08 — trustProxy reads Fly-Client-IP (spoof-proof) instead of X-Forwarded-For
        server: { ...actual.config.server, trustProxy: true },
        auth: {
          ...actual.config.auth,
          native: {
            ...actual.config.auth.native,
            jwt: { current: configState.jwtCurrent, previous: undefined },
          },
        },
      };
    },
  };
});

const revokeRefreshMock = vi.hoisted(() =>
  vi.fn<(args: unknown) => Promise<void>>(async () => undefined),
);
vi.mock('../refresh-tokens.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RefreshTokensModule>();
  return {
    ...actual,
    revokeRefreshToken: (args: unknown) => revokeRefreshMock(args),
  };
});

vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock('../../clustering/data-store.js', () => ({
  startLocationRefresh: vi.fn(),
  getLocations: () => ({ locations: [], loadedAt: Date.now() }),
  isLocationLoading: () => false,
}));

vi.mock('../../merchants/sync.js', () => ({
  startMerchantRefresh: vi.fn(),
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

vi.mock('../../clustering/handler.js', () => ({
  clustersHandler: vi.fn(async (c: { json: (data: unknown) => Response }) =>
    c.json({ clusterPoints: [], locationPoints: [] }),
  ),
}));

import { app } from '../../app.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

describe('requireAuth middleware (via /api/orders)', () => {
  it('rejects missing Authorization header with 401', async () => {
    const res = await app.request('/api/orders');
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, string>;
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('rejects malformed Authorization header (no Bearer prefix)', async () => {
    const res = await app.request('/api/orders', {
      headers: { Authorization: 'Basic abc123' },
    });
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/auth/session', () => {
  it('succeeds without calling upstream for an unrecognised refresh token', async () => {
    const res = await app.request('/api/auth/session', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'fly-client-ip': '10.0.0.3' },
      body: JSON.stringify({ refreshToken: 'rt-to-revoke', platform: 'web' }),
    });

    expect(res.status).toBe(200);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('A2-565: revokes the Loop-native refresh-token row when the token is Loop-signed', async () => {
    const key = 'k'.repeat(32);
    configState.jwtCurrent = key;
    const { signLoopToken } = await import('../tokens.js');
    const { token, claims } = signLoopToken({
      sub: 'u-1',
      email: 'a@b.com',
      typ: 'refresh',
      ttlSeconds: 300,
    });
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    revokeRefreshMock.mockClear();
    const res = await app.request('/api/auth/session', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'fly-client-ip': '10.0.0.4' },
      body: JSON.stringify({ refreshToken: token, platform: 'web' }),
    });
    expect(res.status).toBe(200);
    expect(revokeRefreshMock).toHaveBeenCalledWith(expect.objectContaining({ jti: claims.jti }));
    configState.jwtCurrent = undefined;
  });

  it('rate limits at 20/min per IP', async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    const ip = '203.0.113.200';
    const doReq = (): Promise<Response> | Response =>
      app.request('/api/auth/session', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'fly-client-ip': ip },
        body: JSON.stringify({ refreshToken: 'x', platform: 'web' }),
      });

    for (let i = 0; i < 20; i++) {
      const r = await doReq();
      expect(r.status).toBe(200);
    }
    const limited = await doReq();
    expect(limited.status).toBe(429);
  });
});
