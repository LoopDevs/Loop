import { describe, it, expect, vi } from 'vitest';

// BK-pooler: `withAdvisoryLock` reads `env.DATABASE_URL` (frozen at
// module load) to decide whether it's talking to a transaction-mode
// pooler. `db/client.ts` touches the env module at import-time, so the
// pooler URL has to be set BEFORE the import — same hoisted-env pattern
// as `pooled-url.test.ts`. `postgres()` is lazy, so importing the module
// with a pooler URL opens no real connection.
vi.hoisted(() => {
  process.env['DATABASE_URL'] =
    'postgresql://postgres.abcdef:pass@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
});

import { withAdvisoryLock } from '../client.js';

describe('withAdvisoryLock under a transaction-pooler DATABASE_URL (BK-pooler)', () => {
  it('fails CLOSED (throws) instead of silently running fn un-serialised', async () => {
    // A session advisory lock cannot be held reliably through a
    // transaction pooler, so running `fn` would drop the fleet-wide
    // fence. The wrapper must refuse — not warn-and-proceed.
    const fn = vi.fn(async () => 'must-not-run');

    await expect(withAdvisoryLock(0x1234_5678n, fn)).rejects.toThrow(/transaction-mode pooler/i);

    // The whole point of failing closed: the un-serialised body never ran.
    expect(fn).not.toHaveBeenCalled();
  });
});
