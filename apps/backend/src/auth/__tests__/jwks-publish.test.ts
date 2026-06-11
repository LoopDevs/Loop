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
import { generateKeyPairSync } from 'node:crypto';
import { Hono } from 'hono';

// Module scope (not vi.hoisted) is fine: the route module is only
// ever imported dynamically inside appWithEnv, after the keys exist.
const gen = (): string =>
  generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
const CURRENT_PEM = gen();
const PREVIOUS_PEM = gen();

const MANAGED_KEYS = [
  'LOOP_JWT_SIGNING_KEY',
  'LOOP_JWT_SIGNING_KEY_PREVIOUS',
  'LOOP_JWT_RSA_PRIVATE_KEY',
  'LOOP_JWT_RSA_PRIVATE_KEY_PREVIOUS',
  'DISABLE_RATE_LIMITING',
] as const;

/** Re-imports env + routes with exactly the given vars and mounts the app. */
async function appWithEnv(
  vars: Partial<Record<(typeof MANAGED_KEYS)[number], string>>,
): Promise<Hono> {
  vi.resetModules();
  for (const k of MANAGED_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  const { mountWellKnownRoutes } = await import('../../routes/well-known.js');
  const app = new Hono();
  mountWellKnownRoutes(app);
  return app;
}

beforeEach(() => {
  vi.resetModules();
});

afterAll(() => {
  for (const k of MANAGED_KEYS) delete process.env[k];
  vi.resetModules();
});

describe('GET /.well-known/jwks.json', () => {
  it('serves a valid JWKS with both kids during a rotation window', async () => {
    const app = await appWithEnv({
      LOOP_JWT_RSA_PRIVATE_KEY: CURRENT_PEM,
      LOOP_JWT_RSA_PRIVATE_KEY_PREVIOUS: PREVIOUS_PEM,
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
    const app = await appWithEnv({
      LOOP_JWT_RSA_PRIVATE_KEY: CURRENT_PEM,
      LOOP_JWT_RSA_PRIVATE_KEY_PREVIOUS: PREVIOUS_PEM,
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
    const app = await appWithEnv({ LOOP_JWT_RSA_PRIVATE_KEY: CURRENT_PEM });
    const res = await app.request('/.well-known/jwks.json');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
  });

  it('serves a valid empty JWKS when RS256 is unconfigured (pre-cutover deployment)', async () => {
    const app = await appWithEnv({ LOOP_JWT_SIGNING_KEY: 'h'.repeat(32) });
    const res = await app.request('/.well-known/jwks.json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: unknown[] };
    expect(body.keys).toEqual([]);
  });

  it('rate-limits at 120/min per IP with a Retry-After on the 429', async () => {
    const app = await appWithEnv({ LOOP_JWT_RSA_PRIVATE_KEY: CURRENT_PEM });
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
