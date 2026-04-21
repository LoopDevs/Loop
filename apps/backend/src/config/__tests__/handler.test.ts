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

beforeEach(() => {
  vi.resetModules();
  delete process.env['LOOP_AUTH_NATIVE_ENABLED'];
  delete process.env['LOOP_WORKERS_ENABLED'];
  delete process.env['LOOP_STELLAR_DEPOSIT_ADDRESS'];
});

afterEach(() => {
  delete process.env['LOOP_AUTH_NATIVE_ENABLED'];
  delete process.env['LOOP_WORKERS_ENABLED'];
  delete process.env['LOOP_STELLAR_DEPOSIT_ADDRESS'];
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
    };
    expect(body.loopAuthNativeEnabled).toBe(false);
    expect(body.loopOrdersEnabled).toBe(false);
    expect(headers['Cache-Control']).toMatch(/max-age=600/);
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
});
