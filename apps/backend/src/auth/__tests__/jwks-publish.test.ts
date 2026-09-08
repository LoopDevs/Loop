/**
 * `GET /.well-known/jwks.json` endpoint tests (ADR 030 Phase A).
 *
 * Drives the real route module (`routes/well-known.ts`, including the
 * rate-limit middleware) mounted on a minimal Hono app — the same
 * shape `app.ts` produces, without the unrelated background-task
 * imports the full app would drag in.
 *
 * Keys are generated at runtime — never commit a PEM fixture.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type * as ConfigModule from '../../config/index.js';
import { generateKeyPairSync } from 'node:crypto';
import { Hono } from 'hono';

// Module scope (not vi.hoisted) is fine: the route module is only
// ever imported dynamically inside appWithKeys, after the keys exist.
const gen = (): string =>
  generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
const CURRENT_PEM = gen();
const PREVIOUS_PEM = gen();

/**
 * The signing keys are the only config these tests vary. The mock
 * serves a mutable `jwt` block over the real (test-fixture) config, so
 * `loadWithKeys` below only has to assign into it.
 */
const { jwtState } = vi.hoisted(() => ({
  jwtState: {
    hs256: { current: undefined as string | undefined, previous: undefined as string | undefined },
    rs256: { current: undefined as string | undefined, previous: undefined as string | undefined },
  },
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
          native: { ...actual.config.auth.native, enabled: true, jwt: jwtState },
        },
      };
    },
  };
});

/** The signing keys `loadWithKeys` accepts, mirroring `auth.native.jwt`. */
interface JwtKeys {
  hs256?: string;
  hs256Previous?: string;
  rs256?: string;
  rs256Previous?: string;
}

/** Applies exactly the given keys, clearing every slot not named. */
function applyKeys(keys: JwtKeys): void {
  jwtState.hs256.current = keys.hs256;
  jwtState.hs256.previous = keys.hs256Previous;
  jwtState.rs256.current = keys.rs256;
  jwtState.rs256.previous = keys.rs256Previous;
}

/** Re-imports the routes with exactly the given keys and mounts the app. */
async function appWithKeys(keys: JwtKeys): Promise<Hono> {
  vi.resetModules();
  applyKeys(keys);
  const { mountWellKnownRoutes } = await import('../../routes/well-known.js');
  const app = new Hono();
  mountWellKnownRoutes(app);
  return app;
}

beforeEach(() => {
  vi.resetModules();
});

afterAll(() => {
  applyKeys({});
  vi.resetModules();
});

describe('GET /.well-known/jwks.json', () => {
  it('serves a valid JWKS with both kids during a rotation window', async () => {
    const app = await appWithKeys({
      rs256: CURRENT_PEM,
      rs256Previous: PREVIOUS_PEM,
    });
    const res = await app.request('/.well-known/jwks.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys).toHaveLength(2);
    const kids = body.keys.map((k) => k['kid']);
    expect(new Set(kids).size).toBe(2);
    for (const key of body.keys) {
      expect(key['kty']).toBe('RSA');
      expect(key['alg']).toBe('RS256');
      expect(key['use']).toBe('sig');
      expect(typeof key['n']).toBe('string');
      expect(typeof key['e']).toBe('string');
      expect(typeof key['kid']).toBe('string');
    }
  });

  it('never leaks private-key material (no d/p/q/dp/dq/qi anywhere in the body)', async () => {
    const app = await appWithKeys({
      rs256: CURRENT_PEM,
      rs256Previous: PREVIOUS_PEM,
    });
    const res = await app.request('/.well-known/jwks.json');
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
    for (const key of body.keys) {
      expect(Object.keys(key).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
      for (const priv of ['d', 'p', 'q', 'dp', 'dq', 'qi']) {
        expect(key[priv]).toBeUndefined();
      }
    }
  });

  it('sets Cache-Control: public, max-age=3600', async () => {
    const app = await appWithKeys({ rs256: CURRENT_PEM });
    const res = await app.request('/.well-known/jwks.json');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
  });

  it('serves a valid empty JWKS when RS256 is unconfigured (pre-cutover deployment)', async () => {
    const app = await appWithKeys({ hs256: 'rs256-test-hs-signing-key-32ch!!' });
    const res = await app.request('/.well-known/jwks.json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: unknown[] };
    expect(body.keys).toEqual([]);
  });

  it('rate-limits at 120/min per IP with a Retry-After on the 429', async () => {
    const app = await appWithKeys({ rs256: CURRENT_PEM });
    let lastStatus = 0;
    for (let i = 0; i < 120; i += 1) {
      lastStatus = (await app.request('/.well-known/jwks.json')).status;
    }
    expect(lastStatus).toBe(200);
    const limited = await app.request('/.well-known/jwks.json');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).not.toBeNull();
  });
});
