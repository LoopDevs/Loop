import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as ConfigModule from '../index.js';
import type { Context } from 'hono';

/**
 * The handler is a pure projection of `config`, so the mock serves a
 * mutable subset of the settings it reads over the real (test-fixture)
 * config, and each test assigns the ones it cares about.
 */
const { configState } = vi.hoisted(() => ({
  configState: {
    nativeAuthEnabled: false,
    phase1Only: false,
    google: {
      web: undefined as string | undefined,
      ios: undefined as string | undefined,
      android: undefined as string | undefined,
    },
    apple: { serviceId: undefined as string | undefined },
    minSupportedVersion: {
      ios: undefined as string | undefined,
      android: undefined as string | undefined,
    },
  },
}));

vi.mock('../index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    get config() {
      return {
        ...actual.config,
        auth: {
          ...actual.config.auth,
          native: { ...actual.config.auth.native, enabled: configState.nativeAuthEnabled },
          social: { google: configState.google, apple: configState.apple },
        },
        launch: { phase1Only: configState.phase1Only },
        mobile: {
          ...actual.config.mobile,
          minSupportedVersion: configState.minSupportedVersion,
        },
      };
    },
  };
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

/** Back to the all-defaults posture between tests. */
function resetConfigState(): void {
  configState.nativeAuthEnabled = false;
  configState.phase1Only = false;
  configState.google = { web: undefined, ios: undefined, android: undefined };
  configState.apple = { serviceId: undefined };
  configState.minSupportedVersion = { ios: undefined, android: undefined };
}

beforeEach(() => {
  vi.resetModules();
  resetConfigState();
});

afterEach(() => {
  resetConfigState();
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
    expect((body as unknown as { phase1Only: boolean }).phase1Only).toBe(false);
    expect(body.social).toEqual({
      googleClientIdWeb: null,
      googleClientIdIos: null,
      googleClientIdAndroid: null,
      appleServiceId: null,
    });
    expect(headers['Cache-Control']).toMatch(/max-age=600/);
  });

  it('surfaces configured social client ids', async () => {
    configState.google = {
      web: 'web-client.apps.googleusercontent.com',
      ios: undefined,
      android: undefined,
    };
    configState.apple = { serviceId: 'io.loopfinance.app' };
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
  });

  // ADR 052: the operator API creds are boot-required and the
  // order-mirror machinery always runs, so native auth is the only
  // gate loopOrdersEnabled reflects.
  it('sets loopOrdersEnabled with auth.native.enabled alone', async () => {
    configState.nativeAuthEnabled = true;
    const { configHandler } = await import('../handler.js');
    const { ctx } = makeCtx();
    const body = (await configHandler(ctx).json()) as {
      loopAuthNativeEnabled: boolean;
      loopOrdersEnabled: boolean;
    };
    expect(body.loopAuthNativeEnabled).toBe(true);
    expect(body.loopOrdersEnabled).toBe(true);
  });

  it('keeps loopOrdersEnabled=false without native auth', async () => {
    const { configHandler } = await import('../handler.js');
    const { ctx } = makeCtx();
    const body = (await configHandler(ctx).json()) as { loopOrdersEnabled: boolean };
    expect(body.loopOrdersEnabled).toBe(false);
  });

  it('surfaces the CTX payment-currency allowlist (default XLM)', async () => {
    const { configHandler } = await import('../handler.js');
    const { ctx } = makeCtx();
    const body = (await configHandler(ctx).json()) as { ctxPaymentCurrencies: string[] };
    expect(body.ctxPaymentCurrencies).toEqual(['XLM']);
  });

  it('reflects launch.phase1Only independently of the loop-native flags', async () => {
    configState.phase1Only = true;
    const { configHandler } = await import('../handler.js');
    const { ctx } = makeCtx();
    const body = (await configHandler(ctx).json()) as { phase1Only: boolean };
    expect(body.phase1Only).toBe(true);
  });

  it('defaults minSupportedVersion to null per platform when unset (no gate)', async () => {
    const { configHandler } = await import('../handler.js');
    const { ctx } = makeCtx();
    const body = (await configHandler(ctx).json()) as {
      minSupportedVersion: { ios: string | null; android: string | null };
    };
    expect(body.minSupportedVersion).toEqual({ ios: null, android: null });
  });

  it('surfaces per-platform minSupportedVersion floors independently', async () => {
    // Android floor left unset — must stay null (no gate on that platform).
    configState.minSupportedVersion = { ios: '0.4.0', android: undefined };
    const { configHandler } = await import('../handler.js');
    const { ctx } = makeCtx();
    const body = (await configHandler(ctx).json()) as {
      minSupportedVersion: { ios: string | null; android: string | null };
    };
    expect(body.minSupportedVersion.ios).toBe('0.4.0');
    expect(body.minSupportedVersion.android).toBeNull();
  });
});
