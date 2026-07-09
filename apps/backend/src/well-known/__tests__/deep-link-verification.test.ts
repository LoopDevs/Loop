/**
 * `GET /.well-known/apple-app-site-association` +
 * `GET /.well-known/assetlinks.json` endpoint tests (M-3 deep linking).
 *
 * Drives the real route module (`routes/well-known.ts`, including the
 * rate-limit middleware) mounted on a minimal Hono app — same shape as
 * `auth/__tests__/jwks-publish.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { Hono } from 'hono';

const MANAGED_KEYS = ['APPLE_TEAM_ID', 'ANDROID_CERT_SHA256', 'DISABLE_RATE_LIMITING'] as const;

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

describe('GET /.well-known/apple-app-site-association', () => {
  it('404s with WELL_KNOWN_NOT_CONFIGURED when APPLE_TEAM_ID is unset', async () => {
    const app = await appWithEnv({});
    const res = await app.request('/.well-known/apple-app-site-association');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('WELL_KNOWN_NOT_CONFIGURED');
  });

  it('serves the association document when APPLE_TEAM_ID is set', async () => {
    const app = await appWithEnv({ APPLE_TEAM_ID: 'ABCDE12345' });
    const res = await app.request('/.well-known/apple-app-site-association');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as {
      applinks: { apps: unknown[]; details: Array<{ appID: string; paths: string[] }> };
    };
    expect(body.applinks.apps).toEqual([]);
    expect(body.applinks.details).toEqual([
      { appID: 'ABCDE12345.io.loopfinance.app', paths: ['*'] },
    ]);
  });

  it('sets Cache-Control: public, max-age=300', async () => {
    const app = await appWithEnv({ APPLE_TEAM_ID: 'ABCDE12345' });
    const res = await app.request('/.well-known/apple-app-site-association');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('rate-limits at 120/min per IP with a Retry-After on the 429', async () => {
    const app = await appWithEnv({ APPLE_TEAM_ID: 'ABCDE12345' });
    let lastStatus = 0;
    for (let i = 0; i < 120; i += 1) {
      lastStatus = (await app.request('/.well-known/apple-app-site-association')).status;
    }
    expect(lastStatus).toBe(200);
    const limited = await app.request('/.well-known/apple-app-site-association');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).not.toBeNull();
  });
});

describe('GET /.well-known/assetlinks.json', () => {
  it('404s with WELL_KNOWN_NOT_CONFIGURED when ANDROID_CERT_SHA256 is unset', async () => {
    const app = await appWithEnv({});
    const res = await app.request('/.well-known/assetlinks.json');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('WELL_KNOWN_NOT_CONFIGURED');
  });

  it('serves the asset-links statement when ANDROID_CERT_SHA256 is set', async () => {
    const app = await appWithEnv({ ANDROID_CERT_SHA256: 'AA:BB:CC' });
    const res = await app.request('/.well-known/assetlinks.json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      relation: string[];
      target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] };
    }>;
    expect(body).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'io.loopfinance.app',
          sha256_cert_fingerprints: ['AA:BB:CC'],
        },
      },
    ]);
  });

  it('accepts a comma-separated list of fingerprints (debug + release rollout)', async () => {
    const app = await appWithEnv({ ANDROID_CERT_SHA256: 'AA:BB:CC, DD:EE:FF ,11:22:33' });
    const res = await app.request('/.well-known/assetlinks.json');
    const body = (await res.json()) as Array<{
      target: { sha256_cert_fingerprints: string[] };
    }>;
    expect(body[0]?.target.sha256_cert_fingerprints).toEqual(['AA:BB:CC', 'DD:EE:FF', '11:22:33']);
  });

  it('sets Cache-Control: public, max-age=300', async () => {
    const app = await appWithEnv({ ANDROID_CERT_SHA256: 'AA:BB:CC' });
    const res = await app.request('/.well-known/assetlinks.json');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('rate-limits at 120/min per IP with a Retry-After on the 429', async () => {
    const app = await appWithEnv({ ANDROID_CERT_SHA256: 'AA:BB:CC' });
    let lastStatus = 0;
    for (let i = 0; i < 120; i += 1) {
      lastStatus = (await app.request('/.well-known/assetlinks.json')).status;
    }
    expect(lastStatus).toBe(200);
    const limited = await app.request('/.well-known/assetlinks.json');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).not.toBeNull();
  });
});
