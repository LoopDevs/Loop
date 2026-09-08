import { describe, it, expect, vi } from 'vitest';
import type * as ConfigModule from '../config/index.js';
import type { Context } from 'hono';

/**
 * A2-1526 — end-to-end coverage of the `TRUST_PROXY` rate-limit
 * trust boundary. The audit flagged this as a defense that was never
 * exercised by a test: an attacker spoofing `X-Forwarded-For` against
 * a deployment where `TRUST_PROXY=false` (single-machine or non-Fly
 * setup) would rotate their per-IP bucket on every request and slip
 * past the rate limiter. If the env flag ever flipped or the
 * `clientIpFor` predicate regressed, no test would catch it.
 *
 * Two test files cover the two env modes (each mocks `config.server.trustProxy`
 * at module-load time):
 *   - trust-proxy.test.ts — TRUST_PROXY=false (this file)
 *   - trust-proxy-trusted.test.ts — TRUST_PROXY=true (sibling file)
 *
 * Both files drive the exported `clientIpFor(c)` directly with
 * synthetic Hono contexts — end-to-end enough to cover the branch
 * logic, fast enough to run in the unit suite.
 */

// Only `server.trustProxy` is under test — everything else the import
// chain reads comes from the real (test-fixture) config.
vi.mock('../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    config: {
      ...actual.config,
      server: { ...actual.config.server, trustProxy: false },
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

function makeCtx(args: { xForwardedFor?: string; socketAddress?: string }): Context {
  const headers = new Map<string, string>();
  if (args.xForwardedFor !== undefined) headers.set('x-forwarded-for', args.xForwardedFor);
  return {
    req: {
      header: (name: string) => headers.get(name.toLowerCase()),
      // `getConnInfo` in hono/adapter/node reads `c.env.incoming.socket.remoteAddress`.
      // Return a minimal shape that the bundled `getConnInfo` can introspect; when
      // `socketAddress` is omitted the helper will throw and our code falls back to
      // `'unknown'` — that's the "conninfo unavailable" branch.
    },
    env:
      args.socketAddress !== undefined
        ? { incoming: { socket: { remoteAddress: args.socketAddress } } }
        : {},
  } as unknown as Context;
}

describe('clientIpFor — TRUST_PROXY=false (A2-1526)', () => {
  it('ignores X-Forwarded-For entirely — a spoofed XFF must not leak into the bucket', () => {
    const ctx = makeCtx({
      xForwardedFor: '1.2.3.4',
      socketAddress: '10.0.0.1',
    });
    // Defense: the spoofed XFF is present, but the socket address wins.
    expect(clientIpFor(ctx)).toBe('10.0.0.1');
  });

  it('falls back to `unknown` when the socket address is unavailable (dev/test harness)', () => {
    const ctx = makeCtx({ xForwardedFor: '1.2.3.4' });
    // conninfo throws (no incoming.socket); XFF is ignored → all clients
    // share the `'unknown'` bucket. Conservative by design.
    expect(clientIpFor(ctx)).toBe('unknown');
  });

  it('two requests with DIFFERENT X-Forwarded-For values map to the SAME bucket', () => {
    const a = clientIpFor(makeCtx({ xForwardedFor: '1.2.3.4', socketAddress: '10.0.0.1' }));
    const b = clientIpFor(makeCtx({ xForwardedFor: '5.6.7.8', socketAddress: '10.0.0.1' }));
    // Both clients resolve to the socket IP — rate-limit budget shared.
    expect(a).toBe('10.0.0.1');
    expect(b).toBe('10.0.0.1');
    expect(a).toBe(b);
  });

  it('ignores a multi-valued XFF too (comma-separated chain)', () => {
    const ctx = makeCtx({
      xForwardedFor: '1.2.3.4, 5.6.7.8, 9.10.11.12',
      socketAddress: '10.0.0.1',
    });
    expect(clientIpFor(ctx)).toBe('10.0.0.1');
  });
});
