import { describe, it, expect, vi } from 'vitest';
import type { Context } from 'hono';

/**
 * Feature-flag-off coverage for `loopCreateOrderHandler` lives in its
 * own file: `env.ts` validates `LOOP_AUTH_NATIVE_ENABLED` at module
 * load, so flipping the flag requires a fresh module graph. Doing
 * that with `vi.resetModules()` inside `loop-handler.test.ts` (the
 * flag-on suite) corrupted the shared module registry for tests that
 * ran after it — keeping this variant isolated means the flag value
 * is set once, before any import resolves, and never needs resetting.
 */
vi.hoisted(() => {
  process.env['LOOP_AUTH_NATIVE_ENABLED'] = 'false';
});

// The handler returns 404 before touching the DB, but its module
// graph imports the db client at load time — stub it so this file
// never constructs a real postgres pool.
vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { loopCreateOrderHandler } from '../loop-handler.js';

describe('loopCreateOrderHandler — feature flag off', () => {
  it('returns 404 when LOOP_AUTH_NATIVE_ENABLED is false', async () => {
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
