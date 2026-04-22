import { describe, it, expect } from 'vitest';
import type { Context } from 'hono';
import { adminDiscordNotifiersHandler } from '../discord-notifiers.js';
import { DISCORD_NOTIFIERS } from '../../discord.js';

function makeCtx(): Context {
  return {
    req: {
      query: (_k: string) => undefined,
      param: (_k: string) => undefined,
    },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

describe('adminDiscordNotifiersHandler', () => {
  it('returns every notifier in the catalog', async () => {
    const res = adminDiscordNotifiersHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notifiers: unknown[] };
    expect(body.notifiers).toHaveLength(DISCORD_NOTIFIERS.length);
  });

  it('surfaces the symbolic channel name, not a URL', async () => {
    const res = adminDiscordNotifiersHandler(makeCtx());
    const body = (await res.json()) as { notifiers: Array<{ channel: string }> };
    for (const n of body.notifiers) {
      expect(['orders', 'monitoring', 'admin-audit']).toContain(n.channel);
      // Belt-and-braces: never leak a URL through this surface, in
      // case the catalog is ever edited carelessly.
      expect(n.channel).not.toMatch(/^https?:/);
    }
  });

  it('does not mirror a mutation back to the source catalog', async () => {
    const res = adminDiscordNotifiersHandler(makeCtx());
    const body = (await res.json()) as { notifiers: Array<Record<string, unknown>> };
    // The handler spreads the frozen source into a new array before
    // returning. Mutating the response must not reach back into the
    // const. Attempting to mutate the frozen source throws in strict
    // mode — we test that the source is still frozen post-handler.
    expect(Object.isFrozen(DISCORD_NOTIFIERS)).toBe(true);
    // Also: the body's array is a fresh allocation (not the frozen
    // one itself), so callers can safely sort / filter it.
    expect(() => body.notifiers.push({ bogus: true })).not.toThrow();
  });
});

describe('DISCORD_NOTIFIERS catalog invariants', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(DISCORD_NOTIFIERS)).toBe(true);
  });

  it('has unique notifier names', () => {
    const names = DISCORD_NOTIFIERS.map((n) => n.name);
    const set = new Set(names);
    expect(set.size).toBe(names.length);
  });

  it('covers every notify* function exported from discord.ts', async () => {
    const mod = (await import('../../discord.js')) as Record<string, unknown>;
    const exportedNotifiers = Object.keys(mod).filter(
      (k) => k.startsWith('notify') && typeof mod[k] === 'function',
    );
    const cataloged = new Set(DISCORD_NOTIFIERS.map((n) => n.name));
    for (const n of exportedNotifiers) {
      expect(cataloged.has(n)).toBe(true);
    }
  });
});
