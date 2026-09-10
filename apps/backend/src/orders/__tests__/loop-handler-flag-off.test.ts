import { describe, it, expect, vi } from 'vitest';
import type { Context } from 'hono';
import type * as ConfigModule from '../../config/index.js';

// Flag pinned off for the whole module graph to prevent leakage into sibling cases
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

// Stub db client to prevent store construction at load time
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
