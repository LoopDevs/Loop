import { describe, it, expect, vi } from 'vitest';
import type * as ConfigModule from '../config/index.js';
import type { Context } from 'hono';

// A2-1526 / FT-08 — Fly edge appends real peer to XFF, so leftmost XFF is client-controlled.
// Key on unforgeable Fly-Client-IP to prevent bucket rotation and OTP lockout pinning.

vi.mock('../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    config: {
      ...actual.config,
      server: { ...actual.config.server, trustProxy: true },
    },
  };
});

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
    const ctx = makeCtx({
      xForwardedFor: '1.2.3.4',
      flyClientIp: '203.0.113.7',
      socketAddress: '10.0.0.1',
    });
    expect(clientIpFor(ctx)).toBe('203.0.113.7');
    expect(clientIpFor(ctx)).not.toBe('1.2.3.4');
  });

  it('does NOT fall back to X-Forwarded-For when Fly-Client-IP is absent — uses the socket peer', () => {
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
