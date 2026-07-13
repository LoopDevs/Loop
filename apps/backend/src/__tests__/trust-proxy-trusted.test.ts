import { describe, it, expect, vi } from 'vitest';
import type { Context } from 'hono';

/**
 * A2-1526 / FT-08 — companion file to `trust-proxy.test.ts`. This one
 * mocks `env.TRUST_PROXY = true` at module-load and verifies that the
 * bucket-selection logic keys on the spoof-proof `Fly-Client-IP`
 * header under Fly deployments — and specifically that a client-
 * supplied `X-Forwarded-For` can NOT influence the bucket. Without
 * both flavours of test, a regression that silently inverted the flag
 * (or reverted to trusting leftmost XFF) would only surface the wrong
 * half of the behaviour.
 *
 * FT-08 threat model: Fly's edge *appends* the real peer to
 * `X-Forwarded-For`, so the leftmost XFF entry is whatever the client
 * sent. Trusting it let an attacker rotate their bucket at will and
 * pin a victim's IP into the request-otp bucket to force the OTP
 * lockout. `Fly-Client-IP` is written by the edge and unforgeable, so
 * the limiter keys on that instead.
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

function makeCtx(args: {
  flyClientIp?: string;
  xForwardedFor?: string;
  socketAddress?: string;
}): Context {
  const headers = new Map<string, string>();
  if (args.flyClientIp !== undefined) headers.set('fly-client-ip', args.flyClientIp);
  if (args.xForwardedFor !== undefined) headers.set('x-forwarded-for', args.xForwardedFor);
  return {
    req: { header: (name: string) => headers.get(name.toLowerCase()) },
    env:
      args.socketAddress !== undefined
        ? { incoming: { socket: { remoteAddress: args.socketAddress } } }
        : {},
  } as unknown as Context;
}

describe('clientIpFor — TRUST_PROXY=true (A2-1526 / FT-08)', () => {
  it('keys on the spoof-proof Fly-Client-IP header — the true edge-seen peer', () => {
    const ctx = makeCtx({
      flyClientIp: '203.0.113.7',
      socketAddress: '10.0.0.1',
    });
    expect(clientIpFor(ctx)).toBe('203.0.113.7');
  });

  it('IGNORES a spoofed X-Forwarded-For — Fly-Client-IP wins (FT-08 core defense)', () => {
    // Attacker sends `X-Forwarded-For: <victim-or-rotating-ip>`; Fly appends
    // the real peer and sets Fly-Client-IP. The limiter must bucket on the
    // unforgeable Fly-Client-IP, never the client-supplied XFF.
    const ctx = makeCtx({
      xForwardedFor: '1.2.3.4',
      flyClientIp: '203.0.113.7',
      socketAddress: '10.0.0.1',
    });
    expect(clientIpFor(ctx)).toBe('203.0.113.7');
    expect(clientIpFor(ctx)).not.toBe('1.2.3.4');
  });

  it('does NOT fall back to X-Forwarded-For when Fly-Client-IP is absent — uses the socket peer', () => {
    // No Fly-Client-IP (non-Fly path / internal call). A spoofable XFF is
    // present but must be ignored; we key on the TCP socket instead.
    const ctx = makeCtx({
      xForwardedFor: '1.2.3.4',
      socketAddress: '10.0.0.1',
    });
    expect(clientIpFor(ctx)).toBe('10.0.0.1');
    expect(clientIpFor(ctx)).not.toBe('1.2.3.4');
  });

  it('trims whitespace around the Fly-Client-IP value', () => {
    const ctx = makeCtx({
      flyClientIp: '  203.0.113.7  ',
      socketAddress: '10.0.0.1',
    });
    expect(clientIpFor(ctx)).toBe('203.0.113.7');
  });

  it('falls back to the socket address when Fly-Client-IP is absent (curl to internal / healthcheck)', () => {
    const ctx = makeCtx({ socketAddress: '10.0.0.2' });
    expect(clientIpFor(ctx)).toBe('10.0.0.2');
  });

  it('an attacker rotating X-Forwarded-For maps to the SAME bucket (spoof cannot fan out)', () => {
    // Same real peer (Fly-Client-IP), two different forged XFF values → one
    // bucket. Under the old leftmost-XFF logic these would have been two
    // buckets, defeating the per-IP limit.
    const a = clientIpFor(
      makeCtx({ xForwardedFor: '1.2.3.4', flyClientIp: '203.0.113.7', socketAddress: '10.0.0.1' }),
    );
    const b = clientIpFor(
      makeCtx({ xForwardedFor: '5.6.7.8', flyClientIp: '203.0.113.7', socketAddress: '10.0.0.1' }),
    );
    expect(a).toBe('203.0.113.7');
    expect(b).toBe('203.0.113.7');
    expect(a).toBe(b);
  });

  it('two clients with DIFFERENT Fly-Client-IP values map to DIFFERENT buckets', () => {
    const a = clientIpFor(makeCtx({ flyClientIp: '203.0.113.7', socketAddress: '10.0.0.1' }));
    const b = clientIpFor(makeCtx({ flyClientIp: '198.51.100.9', socketAddress: '10.0.0.1' }));
    expect(a).toBe('203.0.113.7');
    expect(b).toBe('198.51.100.9');
    expect(a).not.toBe(b);
  });

  it('falls back to unknown when Fly-Client-IP absent AND socket-address unavailable', () => {
    const ctx = makeCtx({});
    expect(clientIpFor(ctx)).toBe('unknown');
  });
});
