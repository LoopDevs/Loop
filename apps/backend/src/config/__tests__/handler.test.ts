import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'hono';

vi.hoisted(() => {
  // env.ts snapshots at module load — tests reset module state
  // before touching these vars.
});

function makeCtx(): { headers: Record<string, string>; ctx: Context } {
  const headers: Record<string, string> = {};
  return {
    headers,
    ctx: {
      header: (k: string, v: string) => {
        headers[k] = v;
      },
      json: (body: unknown, status?: number) =>
        new Response(JSON.stringify(body), {
          status: status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
    } as unknown as Context,
  };
}

const LOOP_ISSUER_VARS = [
  'LOOP_STELLAR_USDLOOP_ISSUER',
  'LOOP_STELLAR_GBPLOOP_ISSUER',
  'LOOP_STELLAR_EURLOOP_ISSUER',
];

function clearEnv(): void {
  delete process.env['LOOP_AUTH_NATIVE_ENABLED'];
  delete process.env['LOOP_WORKERS_ENABLED'];
  delete process.env['LOOP_STELLAR_DEPOSIT_ADDRESS'];
  for (const k of LOOP_ISSUER_VARS) delete process.env[k];
}

beforeEach(() => {
  vi.resetModules();
  clearEnv();
});

afterEach(() => {
  clearEnv();
  vi.resetModules();
});

describe('configHandler', () => {
  it('returns all-false when no flags are set', async () => {
    const { configHandler } = await import('../handler.js');
    const { ctx, headers } = makeCtx();
    const res = configHandler(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      loopAuthNativeEnabled: boolean;
      loopOrdersEnabled: boolean;
      social: {
        googleClientIdWeb: string | null;
        googleClientIdIos: string | null;
        googleClientIdAndroid: string | null;
        appleServiceId: string | null;
      };
    };
    expect(body.loopAuthNativeEnabled).toBe(false);
    expect(body.loopOrdersEnabled).toBe(false);
    expect(body.social).toEqual({
      googleClientIdWeb: null,
      googleClientIdIos: null,
      googleClientIdAndroid: null,
      appleServiceId: null,
    });
    expect(headers['Cache-Control']).toMatch(/max-age=600/);
  });

  it('surfaces configured social client ids', async () => {
    process.env['GOOGLE_OAUTH_CLIENT_ID_WEB'] = 'web-client.apps.googleusercontent.com';
    process.env['APPLE_SIGN_IN_SERVICE_ID'] = 'io.loopfinance.app';
    const { configHandler } = await import('../handler.js');
    const { ctx } = makeCtx();
    const body = (await configHandler(ctx).json()) as {
      social: {
        googleClientIdWeb: string | null;
        googleClientIdIos: string | null;
        appleServiceId: string | null;
      };
    };
    expect(body.social.googleClientIdWeb).toBe('web-client.apps.googleusercontent.com');
    expect(body.social.googleClientIdIos).toBeNull();
    expect(body.social.appleServiceId).toBe('io.loopfinance.app');
    delete process.env['GOOGLE_OAUTH_CLIENT_ID_WEB'];
    delete process.env['APPLE_SIGN_IN_SERVICE_ID'];
  });

  it('reflects LOOP_AUTH_NATIVE_ENABLED independently', async () => {
    process.env['LOOP_AUTH_NATIVE_ENABLED'] = 'true';
    const { configHandler } = await import('../handler.js');
    const { ctx } = makeCtx();
    const body = (await configHandler(ctx).json()) as {
      loopAuthNativeEnabled: boolean;
      loopOrdersEnabled: boolean;
    };
    expect(body.loopAuthNativeEnabled).toBe(true);
    // loopOrdersEnabled needs all three: auth flag, workers flag, deposit address.
    expect(body.loopOrdersEnabled).toBe(false);
  });

  it('only sets loopOrdersEnabled when auth + workers + deposit-address are all configured', async () => {
    process.env['LOOP_AUTH_NATIVE_ENABLED'] = 'true';
    process.env['LOOP_WORKERS_ENABLED'] = 'true';
    process.env['LOOP_STELLAR_DEPOSIT_ADDRESS'] =
      'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';
    const { configHandler } = await import('../handler.js');
    const { ctx } = makeCtx();
    const body = (await configHandler(ctx).json()) as { loopOrdersEnabled: boolean };
    expect(body.loopOrdersEnabled).toBe(true);
  });

  it('keeps loopOrdersEnabled=false when the deposit address is missing', async () => {
    process.env['LOOP_AUTH_NATIVE_ENABLED'] = 'true';
    process.env['LOOP_WORKERS_ENABLED'] = 'true';
    // No LOOP_STELLAR_DEPOSIT_ADDRESS.
    const { configHandler } = await import('../handler.js');
    const { ctx } = makeCtx();
    const body = (await configHandler(ctx).json()) as { loopOrdersEnabled: boolean };
    expect(body.loopOrdersEnabled).toBe(false);
  });

  it('reports loopAssets with null issuers + available=false when unconfigured', async () => {
    const { configHandler } = await import('../handler.js');
    const { ctx } = makeCtx();
    const body = (await configHandler(ctx).json()) as {
      loopAssets: {
        USDLOOP: { issuer: string | null; available: boolean };
        GBPLOOP: { issuer: string | null; available: boolean };
        EURLOOP: { issuer: string | null; available: boolean };
      };
    };
    expect(body.loopAssets).toEqual({
      USDLOOP: { issuer: null, available: false },
      GBPLOOP: { issuer: null, available: false },
      EURLOOP: { issuer: null, available: false },
    });
  });

  it('populates loopAssets per-currency when the issuer env is set', async () => {
    process.env['LOOP_STELLAR_USDLOOP_ISSUER'] =
      'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';
    process.env['LOOP_STELLAR_GBPLOOP_ISSUER'] =
      'GBBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';
    // EUR issuer left unset — should still render as null.
    const { configHandler } = await import('../handler.js');
    const { ctx } = makeCtx();
    const body = (await configHandler(ctx).json()) as {
      loopAssets: {
        USDLOOP: { issuer: string | null; available: boolean };
        GBPLOOP: { issuer: string | null; available: boolean };
        EURLOOP: { issuer: string | null; available: boolean };
      };
    };
    expect(body.loopAssets.USDLOOP.available).toBe(true);
    expect(body.loopAssets.USDLOOP.issuer).toMatch(/^G[A-Z2-7]{55}$/);
    expect(body.loopAssets.GBPLOOP.available).toBe(true);
    expect(body.loopAssets.EURLOOP.available).toBe(false);
    expect(body.loopAssets.EURLOOP.issuer).toBeNull();
  });

  it('always emits all three LOOP-asset keys so the client shape is stable', async () => {
    process.env['LOOP_STELLAR_USDLOOP_ISSUER'] =
      'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';
    const { configHandler } = await import('../handler.js');
    const { ctx } = makeCtx();
    const body = (await configHandler(ctx).json()) as {
      loopAssets: Record<string, unknown>;
    };
    expect(Object.keys(body.loopAssets).sort()).toEqual(['EURLOOP', 'GBPLOOP', 'USDLOOP']);
  });
});
