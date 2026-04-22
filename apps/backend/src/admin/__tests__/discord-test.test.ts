import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const { discordMock } = vi.hoisted(() => ({
  discordMock: {
    hasWebhookConfigured: vi.fn((_: string) => true),
    notifyWebhookPing: vi.fn((_c: string, _a: string) => {}),
  },
}));

vi.mock('../../discord.js', () => ({
  hasWebhookConfigured: (c: string) => discordMock.hasWebhookConfigured(c),
  notifyWebhookPing: (c: string, a: string) => discordMock.notifyWebhookPing(c, a),
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminDiscordTestHandler } from '../discord-test.js';

function makeCtx(opts: {
  body?: unknown;
  bodyThrows?: boolean;
  user?: { id?: string } | undefined;
}): Context {
  const store = new Map<string, unknown>();
  if (opts.user !== undefined) store.set('user', opts.user);
  return {
    req: {
      json: async () => {
        if (opts.bodyThrows === true) throw new Error('bad json');
        return opts.body;
      },
      query: (_k: string) => undefined,
      param: (_k: string) => undefined,
    },
    get: (k: string) => store.get(k),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  discordMock.hasWebhookConfigured.mockReset();
  discordMock.notifyWebhookPing.mockReset();
  discordMock.hasWebhookConfigured.mockReturnValue(true);
});

describe('adminDiscordTestHandler', () => {
  it('400 when the body is not JSON', async () => {
    const res = await adminDiscordTestHandler(
      makeCtx({ bodyThrows: true, user: { id: 'admin-1' } }),
    );
    expect(res.status).toBe(400);
    expect(discordMock.notifyWebhookPing).not.toHaveBeenCalled();
  });

  it.each([{}, { channel: '' }, { channel: 'slack' }, { channel: 123 }])(
    '400 on invalid channel: %j',
    async (body) => {
      const res = await adminDiscordTestHandler(makeCtx({ body, user: { id: 'admin-1' } }));
      expect(res.status).toBe(400);
      expect(discordMock.notifyWebhookPing).not.toHaveBeenCalled();
    },
  );

  it('401 when the admin context is missing', async () => {
    const res = await adminDiscordTestHandler(
      makeCtx({ body: { channel: 'orders' }, user: undefined }),
    );
    expect(res.status).toBe(401);
  });

  it('409 WEBHOOK_NOT_CONFIGURED when the channel URL is unset', async () => {
    discordMock.hasWebhookConfigured.mockReturnValue(false);
    const res = await adminDiscordTestHandler(
      makeCtx({ body: { channel: 'monitoring' }, user: { id: 'admin-1' } }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('WEBHOOK_NOT_CONFIGURED');
    expect(discordMock.notifyWebhookPing).not.toHaveBeenCalled();
  });

  it.each(['orders', 'monitoring', 'admin-audit'] as const)(
    '200 and invokes notifyWebhookPing for channel %s',
    async (channel) => {
      const res = await adminDiscordTestHandler(
        makeCtx({ body: { channel }, user: { id: 'admin-1' } }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; channel: string };
      expect(body).toEqual({ status: 'delivered', channel });
      expect(discordMock.notifyWebhookPing).toHaveBeenCalledWith(channel, 'admin-1');
    },
  );
});
