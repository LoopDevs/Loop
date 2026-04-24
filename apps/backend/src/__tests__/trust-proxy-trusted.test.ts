import { describe, it, expect, vi } from 'vitest';
import type { Context } from 'hono';

/**
 * A2-1526 — companion file to `trust-proxy.test.ts`. This one mocks
 * `env.TRUST_PROXY = true` at module-load and verifies that the
 * bucket-selection logic honours `X-Forwarded-For` under Fly / CDN
 * deployments. Without both flavours of test, a regression that
 * silently inverted the flag would only surface the wrong half of
 * the behaviour.
 */

vi.mock('../env.js', () => ({
  env: {
    NODE_ENV: 'test',
    TRUST_PROXY: true,
    PORT: '8080',
    LOG_LEVEL: 'silent',
    GIFT_CARD_API_BASE_URL: 'http://test-upstream.local',
    REFRESH_INTERVAL_HOURS: 6,
    LOCATION_REFRESH_INTERVAL_HOURS: 24,
    CTX_CLIENT_ID_WEB: 'loopweb',
    CTX_CLIENT_ID_IOS: 'loopios',
    CTX_CLIENT_ID_ANDROID: 'loopandroid',
  },
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));
vi.mock('../clustering/data-store.js', () => ({
  startLocationRefresh: vi.fn(),
  getLocations: () => ({ locations: [], loadedAt: Date.now() }),
  isLocationLoading: () => false,
}));
vi.mock('../merchants/sync.js', () => ({
  startMerchantRefresh: vi.fn(),
  getMerchants: () => ({
    merchants: [],
    merchantsById: new Map(),
    merchantsBySlug: new Map(),
    loadedAt: Date.now(),
  }),
}));
vi.mock('../clustering/handler.js', () => ({
  clustersHandler: vi.fn(),
}));

import { clientIpFor } from '../app.js';

function makeCtx(args: { xForwardedFor?: string; socketAddress?: string }): Context {
  const headers = new Map<string, string>();
  if (args.xForwardedFor !== undefined) headers.set('x-forwarded-for', args.xForwardedFor);
  return {
    req: { header: (name: string) => headers.get(name.toLowerCase()) },
    env:
      args.socketAddress !== undefined
        ? { incoming: { socket: { remoteAddress: args.socketAddress } } }
        : {},
  } as unknown as Context;
}

describe('clientIpFor — TRUST_PROXY=true (A2-1526)', () => {
  it('uses the leftmost X-Forwarded-For value — the edge-seen client', () => {
    const ctx = makeCtx({
      xForwardedFor: '1.2.3.4',
      socketAddress: '10.0.0.1',
    });
    expect(clientIpFor(ctx)).toBe('1.2.3.4');
  });

  it('picks the first entry of a multi-value XFF chain (edge → hop → origin)', () => {
    const ctx = makeCtx({
      xForwardedFor: '1.2.3.4, 5.6.7.8, 9.10.11.12',
      socketAddress: '10.0.0.1',
    });
    // Only the leftmost is trusted — middle / right entries are the Fly
    // edge's own hop chain.
    expect(clientIpFor(ctx)).toBe('1.2.3.4');
  });

  it('trims whitespace around the leftmost entry', () => {
    const ctx = makeCtx({
      xForwardedFor: '  1.2.3.4  , 5.6.7.8',
      socketAddress: '10.0.0.1',
    });
    expect(clientIpFor(ctx)).toBe('1.2.3.4');
  });

  it('falls back to the socket address when XFF is absent (curl to internal / healthcheck)', () => {
    const ctx = makeCtx({ socketAddress: '10.0.0.2' });
    expect(clientIpFor(ctx)).toBe('10.0.0.2');
  });

  it('two clients with DIFFERENT X-Forwarded-For values map to DIFFERENT buckets', () => {
    const a = clientIpFor(makeCtx({ xForwardedFor: '1.2.3.4', socketAddress: '10.0.0.1' }));
    const b = clientIpFor(makeCtx({ xForwardedFor: '5.6.7.8', socketAddress: '10.0.0.1' }));
    expect(a).toBe('1.2.3.4');
    expect(b).toBe('5.6.7.8');
    expect(a).not.toBe(b);
  });

  it('falls back to unknown on both XFF absent AND socket-address unavailable', () => {
    const ctx = makeCtx({});
    expect(clientIpFor(ctx)).toBe('unknown');
  });
});
