import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const { envState } = vi.hoisted(() => ({
  envState: {
    orders: undefined as string | undefined,
    monitoring: undefined as string | undefined,
    adminAudit: undefined as string | undefined,
  },
}));
vi.mock('../../env.js', () => ({
  env: new Proxy(
    {},
    {
      get(_, key: string) {
        if (key === 'DISCORD_WEBHOOK_ORDERS') return envState.orders;
        if (key === 'DISCORD_WEBHOOK_MONITORING') return envState.monitoring;
        if (key === 'DISCORD_WEBHOOK_ADMIN_AUDIT') return envState.adminAudit;
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
  envState.adminAudit = undefined;
});

interface ConfigBody {
  orders: string;
  monitoring: string;
  adminAudit: string;
}

describe('adminDiscordConfigHandler', () => {
  it('reports all three configured when URLs are set', async () => {
    envState.orders = 'https://discord/o';
    envState.monitoring = 'https://discord/m';
    envState.adminAudit = 'https://discord/a';
    const res = await adminDiscordConfigHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConfigBody;
    expect(body).toEqual({
      orders: 'configured',
      monitoring: 'configured',
      adminAudit: 'configured',
    });
  });

  it('reports missing when every env var is undefined', async () => {
    const res = await adminDiscordConfigHandler(makeCtx());
    const body = (await res.json()) as ConfigBody;
    expect(body).toEqual({
      orders: 'missing',
      monitoring: 'missing',
      adminAudit: 'missing',
    });
  });

  it('reports mixed configured/missing per channel', async () => {
    envState.orders = 'https://discord/o';
    envState.monitoring = undefined;
    envState.adminAudit = 'https://discord/a';
    const res = await adminDiscordConfigHandler(makeCtx());
    const body = (await res.json()) as ConfigBody;
    expect(body).toEqual({
      orders: 'configured',
      monitoring: 'missing',
      adminAudit: 'configured',
    });
  });

  it('treats empty-string as missing (guards against accidentally-blank env)', async () => {
    envState.orders = '';
    envState.monitoring = 'https://discord/m';
    envState.adminAudit = '';
    const res = await adminDiscordConfigHandler(makeCtx());
    const body = (await res.json()) as ConfigBody;
    expect(body.orders).toBe('missing');
    expect(body.monitoring).toBe('configured');
    expect(body.adminAudit).toBe('missing');
  });

  it('never echoes the actual URL — secrets must not leak', async () => {
    const secret = 'https://discord.com/api/webhooks/123/secret-token';
    envState.orders = secret;
    envState.monitoring = secret;
    envState.adminAudit = secret;
    const res = await adminDiscordConfigHandler(makeCtx());
    const bodyText = await res.text();
    expect(bodyText).not.toContain(secret);
    expect(bodyText).not.toContain('secret-token');
  });
});
