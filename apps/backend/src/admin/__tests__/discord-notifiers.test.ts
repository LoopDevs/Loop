import { describe, it, expect } from 'vitest';
import type { Context } from 'hono';

import { adminDiscordNotifiersHandler } from '../discord-notifiers.js';
import { DISCORD_NOTIFIERS } from '../../discord.js';

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

describe('adminDiscordNotifiersHandler', () => {
  it('returns the DISCORD_NOTIFIERS catalog verbatim', async () => {
    const res = await adminDiscordNotifiersHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notifiers: Array<{ name: string; channel: string; description: string }>;
    };
    // Every entry in the catalog must appear in the response.
    expect(body.notifiers).toHaveLength(DISCORD_NOTIFIERS.length);
    for (const expected of DISCORD_NOTIFIERS) {
      const actual = body.notifiers.find((n) => n.name === expected.name);
      expect(actual).toEqual(expected);
    }
  });

  it('every notifier declares a valid channel', async () => {
    const res = await adminDiscordNotifiersHandler(makeCtx());
    const body = (await res.json()) as {
      notifiers: Array<{ name: string; channel: string; description: string }>;
    };
    for (const n of body.notifiers) {
      expect(['orders', 'monitoring']).toContain(n.channel);
      expect(n.name.length).toBeGreaterThan(0);
      expect(n.description.length).toBeGreaterThan(0);
    }
  });

  it('catalog is immutable — cannot push a new entry at runtime', () => {
    expect(() => {
      (DISCORD_NOTIFIERS as unknown as Array<unknown>).push({});
    }).toThrow();
  });
});
