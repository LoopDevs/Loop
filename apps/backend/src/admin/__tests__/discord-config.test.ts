import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const { envState } = vi.hoisted(() => ({
  envState: {
    orders: undefined as string | undefined,
    monitoring: undefined as string | undefined,
  },
}));
vi.mock('../../env.js', () => ({
  env: new Proxy(
    {},
    {
      get(_, key: string) {
        if (key === 'DISCORD_WEBHOOK_ORDERS') return envState.orders;
        if (key === 'DISCORD_WEBHOOK_MONITORING') return envState.monitoring;
        return undefined;
      },
    },
  ),
}));

import { adminDiscordConfigHandler } from '../discord-config.js';

function makeCtx(): Context {
  return {
    req: {},
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  envState.orders = undefined;
  envState.monitoring = undefined;
});

describe('adminDiscordConfigHandler', () => {
  it('reports both configured when URLs are set', async () => {
    envState.orders = 'https://discord/o';
    envState.monitoring = 'https://discord/m';
    const res = await adminDiscordConfigHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orders: string; monitoring: string };
    expect(body).toEqual({ orders: 'configured', monitoring: 'configured' });
  });

  it('reports missing when both env vars are undefined', async () => {
    const res = await adminDiscordConfigHandler(makeCtx());
    const body = (await res.json()) as { orders: string; monitoring: string };
    expect(body).toEqual({ orders: 'missing', monitoring: 'missing' });
  });

  it('reports mixed configured/missing per channel', async () => {
    envState.orders = 'https://discord/o';
    envState.monitoring = undefined;
    const res = await adminDiscordConfigHandler(makeCtx());
    const body = (await res.json()) as { orders: string; monitoring: string };
    expect(body).toEqual({ orders: 'configured', monitoring: 'missing' });
  });

  it('treats empty-string as missing (guards against accidentally-blank env)', async () => {
    envState.orders = '';
    envState.monitoring = 'https://discord/m';
    const res = await adminDiscordConfigHandler(makeCtx());
    const body = (await res.json()) as { orders: string; monitoring: string };
    expect(body.orders).toBe('missing');
    expect(body.monitoring).toBe('configured');
  });

  it('never echoes the actual URL — secrets must not leak', async () => {
    const secret = 'https://discord.com/api/webhooks/123/secret-token';
    envState.orders = secret;
    envState.monitoring = secret;
    const res = await adminDiscordConfigHandler(makeCtx());
    const bodyText = await res.text();
    expect(bodyText).not.toContain(secret);
    expect(bodyText).not.toContain('secret-token');
  });
});
