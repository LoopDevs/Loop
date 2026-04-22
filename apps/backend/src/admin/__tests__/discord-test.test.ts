import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { discord } = vi.hoisted(() => ({
  discord: { pingResult: true, lastCall: null as { channel: string; actorId: string } | null },
}));
vi.mock('../../discord.js', () => ({
  notifyWebhookPing: vi.fn((channel: 'orders' | 'monitoring', actorId: string): boolean => {
    discord.lastCall = { channel, actorId };
    return discord.pingResult;
  }),
}));

import { adminDiscordTestHandler } from '../discord-test.js';

function makeCtx(body: unknown, user: { id: string } | null = { id: 'admin-uuid' }): Context {
  const store = new Map<string, unknown>();
  if (user !== null) store.set('user', user);
  return {
    req: {
      json: async () => body,
    },
    get: (k: string) => store.get(k),
    json: (responseBody: unknown, status?: number) =>
      new Response(JSON.stringify(responseBody), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  discord.pingResult = true;
  discord.lastCall = null;
});

describe('adminDiscordTestHandler', () => {
  it('200 on a valid channel + forwards the admin id to the notifier', async () => {
    const res = await adminDiscordTestHandler(makeCtx({ channel: 'orders' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; channel: string };
    expect(body).toEqual({ ok: true, channel: 'orders' });
    expect(discord.lastCall).toEqual({ channel: 'orders', actorId: 'admin-uuid' });
  });

  it('accepts both channel values', async () => {
    await adminDiscordTestHandler(makeCtx({ channel: 'monitoring' }));
    expect(discord.lastCall?.channel).toBe('monitoring');
    await adminDiscordTestHandler(makeCtx({ channel: 'orders' }));
    expect(discord.lastCall?.channel).toBe('orders');
  });

  it('409 when the target channel has no webhook configured', async () => {
    discord.pingResult = false;
    const res = await adminDiscordTestHandler(makeCtx({ channel: 'monitoring' }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('WEBHOOK_NOT_CONFIGURED');
  });

  it('400 when channel is missing or unknown', async () => {
    for (const body of [null, {}, { channel: 'bogus' }]) {
      const res = await adminDiscordTestHandler(makeCtx(body));
      expect(res.status).toBe(400);
    }
  });

  it('401 when the admin user context is missing (middleware mounted wrong)', async () => {
    const res = await adminDiscordTestHandler(makeCtx({ channel: 'orders' }, null));
    expect(res.status).toBe(401);
  });

  it('400 when the body is not valid JSON', async () => {
    const ctx = {
      req: {
        json: async () => {
          throw new Error('bad json');
        },
      },
      get: () => ({ id: 'admin-uuid' }),
      json: (body: unknown, status?: number) =>
        new Response(JSON.stringify(body), {
          status: status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
    } as unknown as Context;
    const res = await adminDiscordTestHandler(ctx);
    expect(res.status).toBe(400);
  });
});
