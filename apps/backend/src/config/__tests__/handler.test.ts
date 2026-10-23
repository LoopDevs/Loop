import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as ConfigModule from '../index.js';
import type { Context } from 'hono';

const { configState } = vi.hoisted(() => ({
  configState: {
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

vi.mock('../../ctx/startup.js', () => ({
  loopCryptoPaymentCurrencies: () => ['XLM', 'DASH'],
  loopFiatPaymentCurrencies: () => ['GBP'],
  loopCountries: () => ['US', 'GB'],
  loopStableCurrencies: () => ['XLM.USDC'],
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

function resetConfigState(): void {
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
  it('returns the defaults when nothing is configured', async () => {
    const { configHandler } = await import('../handler.js');
    const { ctx, headers } = makeCtx();
    const res = configHandler(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      social: {
        googleClientIdWeb: string | null;
        googleClientIdIos: string | null;
        googleClientIdAndroid: string | null;
        appleServiceId: string | null;
      };
    };
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

  it('surfaces the operator company payment currencies, countries and stable currencies', async () => {
    const { configHandler } = await import('../handler.js');
    const { ctx } = makeCtx();
    const body = (await configHandler(ctx).json()) as {
      ctxPaymentCurrencies: string[];
      fiatPaymentCurrencies: string[];
      countries: string[];
      stableCurrencies: string[];
    };
    expect(body.ctxPaymentCurrencies).toEqual(['XLM', 'DASH']);
    expect(body.fiatPaymentCurrencies).toEqual(['GBP']);
    expect(body.countries).toEqual(['US', 'GB']);
    expect(body.stableCurrencies).toEqual(['XLM.USDC']);
  });

  it('reflects launch.phase1Only', async () => {
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
