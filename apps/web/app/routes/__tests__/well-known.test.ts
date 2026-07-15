import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * FE-03 — the web app must serve the OS App-Link / Universal-Link
 * verification files at the marketing hosts (loopfinance.io / www /
 * beta), env-gated exactly like the backend handler, so Apple/Google
 * verification actually succeeds. Mirrors
 * `apps/backend/src/well-known/__tests__/deep-link-verification.test.ts`.
 */

function clearEnv(): void {
  delete process.env['APPLE_TEAM_ID'];
  delete process.env['ANDROID_CERT_SHA256'];
}

beforeEach(clearEnv);
afterEach(clearEnv);

describe('.well-known/apple-app-site-association loader', () => {
  it('404s WELL_KNOWN_NOT_CONFIGURED when APPLE_TEAM_ID is unset', async () => {
    const { loader } = await import('../well-known.apple-app-site-association');
    const res = loader();
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('WELL_KNOWN_NOT_CONFIGURED');
  });

  it('treats a whitespace/punctuation Team ID as unconfigured (404)', async () => {
    process.env['APPLE_TEAM_ID'] = '  ';
    const { loader } = await import('../well-known.apple-app-site-association');
    expect(loader().status).toBe(404);
    process.env['APPLE_TEAM_ID'] = 'ABC 123';
    const { loader: loader2 } = await import('../well-known.apple-app-site-association');
    expect(loader2().status).toBe(404);
  });

  it('serves the AASA with the bundle-id-scoped appID when configured', async () => {
    process.env['APPLE_TEAM_ID'] = 'ABCDE12345';
    const { loader } = await import('../well-known.apple-app-site-association');
    const res = loader();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toMatch(/max-age=300/);
    const body = (await res.json()) as {
      applinks: { details: Array<{ appID: string; paths: string[] }> };
    };
    expect(body.applinks.details[0]?.appID).toBe('ABCDE12345.io.loopfinance.app');
    expect(body.applinks.details[0]?.paths).toEqual(['*']);
  });
});

describe('.well-known/assetlinks.json loader', () => {
  it('404s WELL_KNOWN_NOT_CONFIGURED when ANDROID_CERT_SHA256 is unset', async () => {
    const { loader } = await import('../well-known.assetlinks');
    const res = loader();
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('WELL_KNOWN_NOT_CONFIGURED');
  });

  it('treats a comma-only value as unconfigured (never an empty fingerprint list)', async () => {
    process.env['ANDROID_CERT_SHA256'] = ' , ';
    const { loader } = await import('../well-known.assetlinks');
    expect(loader().status).toBe(404);
  });

  it('serves assetlinks with the trimmed, comma-split fingerprints when configured', async () => {
    process.env['ANDROID_CERT_SHA256'] = 'AA:BB:CC , DD:EE:FF';
    const { loader } = await import('../well-known.assetlinks');
    const res = loader();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toMatch(/max-age=300/);
    const body = (await res.json()) as Array<{
      target: { package_name: string; sha256_cert_fingerprints: string[] };
    }>;
    expect(body[0]?.target.package_name).toBe('io.loopfinance.app');
    expect(body[0]?.target.sha256_cert_fingerprints).toEqual(['AA:BB:CC', 'DD:EE:FF']);
  });
});
