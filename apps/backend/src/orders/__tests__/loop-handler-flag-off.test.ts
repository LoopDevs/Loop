import { describe, it, expect, vi } from 'vitest';
import type { Context } from 'hono';
import type * as ConfigModule from '../../config/index.js';

/**
 * Feature-flag-off coverage for `loopCreateOrderHandler` lives in its
 * own file so the flag is pinned off for the whole module graph, with
 * no per-test toggling to leak into a sibling case. The flag-on suite
 * is `loop-handler.test.ts`.
 */
vi.mock('../../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    config: {
      ...actual.config,
      auth: {
        ...actual.config.auth,
        native: { ...actual.config.auth.native, enabled: false },
      },
    },
  };
});

// The handler returns 404 before touching the DB, but its module
// graph imports the db client at load time — stub it so this file
// never constructs a store.
vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { loopCreateOrderHandler } from '../loop-handler.js';

describe('loopCreateOrderHandler — feature flag off', () => {
  it('returns 404 when auth.native.enabled is false', async () => {
    const store = new Map<string, unknown>();
    const ctx = {
      req: { json: async () => ({}) },
      get: (k: string) => store.get(k),
      json: (b: unknown, status?: number) =>
        new Response(JSON.stringify(b), { status: status ?? 200 }),
    } as unknown as Context;
    const res = await loopCreateOrderHandler(ctx);
    expect(res.status).toBe(404);
  });
});
