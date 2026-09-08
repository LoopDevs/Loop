/**
 * `GET /.well-known/apple-app-site-association` +
 * `GET /.well-known/assetlinks.json` endpoint tests (M-3 deep linking).
 *
 * Drives the real route module (`routes/well-known.ts`, including the
 * rate-limit middleware) mounted on a minimal Hono app — same shape as
 * `auth/__tests__/jwks-publish.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type * as ConfigModule from '../../config/index.js';
import { Hono } from 'hono';

/**
 * The deep-link settings are the only config these tests vary; the mock
 * serves a mutable `mobile.deepLinks` block over the real (test-fixture)
 * config.
 */
const { deepLinkState } = vi.hoisted(() => ({
  deepLinkState: {
    apple: { teamId: undefined as string | undefined },
    android: { certFingerprints: [] as string[] },
  },
}));

vi.mock('../../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    get config() {
      return {
        ...actual.config,
        mobile: { ...actual.config.mobile, deepLinks: deepLinkState },
      };
    },
  };
});

/** The deep-link settings `appWithDeepLinks` accepts. */
interface DeepLinkConfig {
  appleTeamId?: string;
  androidCertFingerprints?: string[];
}

/** Re-imports the routes with exactly the given settings and mounts the app. */
async function appWithDeepLinks(settings: DeepLinkConfig): Promise<Hono> {
  vi.resetModules();
  deepLinkState.apple.teamId = settings.appleTeamId;
  deepLinkState.android.certFingerprints = settings.androidCertFingerprints ?? [];
  const { mountWellKnownRoutes } = await import('../../routes/well-known.js');
  const app = new Hono();
  mountWellKnownRoutes(app);
  return app;
}

beforeEach(() => {
  vi.resetModules();
});

afterAll(() => {
  deepLinkState.apple.teamId = undefined;
  deepLinkState.android.certFingerprints = [];
  vi.resetModules();
});

describe('GET /.well-known/apple-app-site-association', () => {
  it('404s with WELL_KNOWN_NOT_CONFIGURED when the Apple team id is unset', async () => {
    const app = await appWithDeepLinks({});
    const res = await app.request('/.well-known/apple-app-site-association');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('WELL_KNOWN_NOT_CONFIGURED');
  });

  // API-02: a present-but-blank / whitespace / malformed value passed
  // the old `=== undefined` guard and served a broken AASA file with an
  // empty or mangled appID. It must now read as "not configured" (404).
  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['contains internal whitespace', 'ABCDE 12345'],
    ['contains punctuation', 'ABCDE.12345'],
  ])('404s when the Apple team id is %s', async (_label, value) => {
    const app = await appWithDeepLinks({ appleTeamId: value });
    const res = await app.request('/.well-known/apple-app-site-association');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('WELL_KNOWN_NOT_CONFIGURED');
  });

  it('trims surrounding whitespace so a padded APPLE_TEAM_ID yields a clean appID', async () => {
    // The un-fixed handler interpolated the raw value, producing
    // `  ABCDE12345  .io.loopfinance.app`. The guard now trims first.
    const app = await appWithDeepLinks({ appleTeamId: '  ABCDE12345  ' });
    const res = await app.request('/.well-known/apple-app-site-association');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      applinks: { details: Array<{ appID: string }> };
    };
    expect(body.applinks.details[0]?.appID).toBe('ABCDE12345.io.loopfinance.app');
  });

  it('serves the association document when APPLE_TEAM_ID is set', async () => {
    const app = await appWithDeepLinks({ appleTeamId: 'ABCDE12345' });
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
    const app = await appWithDeepLinks({ appleTeamId: 'ABCDE12345' });
    const res = await app.request('/.well-known/apple-app-site-association');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('rate-limits at 120/min per IP with a Retry-After on the 429', async () => {
    const app = await appWithDeepLinks({ appleTeamId: 'ABCDE12345' });
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
    const app = await appWithDeepLinks({});
    const res = await app.request('/.well-known/assetlinks.json');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('WELL_KNOWN_NOT_CONFIGURED');
  });

  // API-02: a value that collapses to no fingerprints (blank,
  // whitespace, comma-only) passed the old `=== undefined` guard and
  // served an assetlinks statement with `sha256_cert_fingerprints: []`.
  // It must now read as "not configured" (404).
  it.each([
    ['empty', []],
    ['a single empty entry', ['']],
    ['whitespace-only entries', ['   ', ' ']],
  ])('404s when the fingerprint list is %s', async (_label, value) => {
    const app = await appWithDeepLinks({ androidCertFingerprints: value });
    const res = await app.request('/.well-known/assetlinks.json');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('WELL_KNOWN_NOT_CONFIGURED');
  });

  it('serves the asset-links statement when a fingerprint is set', async () => {
    const app = await appWithDeepLinks({ androidCertFingerprints: ['AA:BB:CC'] });
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

  it('accepts a list of fingerprints (debug + release rollout)', async () => {
    const app = await appWithDeepLinks({
      androidCertFingerprints: ['AA:BB:CC', ' DD:EE:FF ', '11:22:33'],
    });
    const res = await app.request('/.well-known/assetlinks.json');
    const body = (await res.json()) as Array<{
      target: { sha256_cert_fingerprints: string[] };
    }>;
    expect(body[0]?.target.sha256_cert_fingerprints).toEqual(['AA:BB:CC', 'DD:EE:FF', '11:22:33']);
  });

  it('sets Cache-Control: public, max-age=300', async () => {
    const app = await appWithDeepLinks({ androidCertFingerprints: ['AA:BB:CC'] });
    const res = await app.request('/.well-known/assetlinks.json');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('rate-limits at 120/min per IP with a Retry-After on the 429', async () => {
    const app = await appWithDeepLinks({ androidCertFingerprints: ['AA:BB:CC'] });
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
