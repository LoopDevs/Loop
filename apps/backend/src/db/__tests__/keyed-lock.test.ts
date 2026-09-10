// withKeyedLock — in-process serialisation replacing pg_advisory_xact_lock — db/keyed-lock.ts
import { describe, it, expect } from 'vitest';
import { withKeyedLock } from '../keyed-lock.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('withKeyedLock', () => {
  it('runs same-key callers one at a time, in arrival order', async () => {
    const events: string[] = [];
    const run = (label: string, ms: number): Promise<void> =>
      withKeyedLock('k', async () => {
        events.push(`${label}:start`);
        await sleep(ms);
        events.push(`${label}:end`);
      });

    await Promise.all([run('a', 15), run('b', 1), run('c', 1)]);

    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('does not serialise different keys', async () => {
    let concurrent = 0;
    let peak = 0;
    const run = (key: string): Promise<void> =>
      withKeyedLock(key, async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await sleep(5);
        concurrent -= 1;
      });

    await Promise.all([run('a'), run('b'), run('c')]);
    expect(peak).toBe(3);
  });

  it('propagates a rejection to its own caller without blocking the next one', async () => {
    const boom = withKeyedLock('k', async () => {
      throw new Error('boom');
    });
    const after = withKeyedLock('k', async () => 'ran');

    await expect(boom).rejects.toThrow('boom');
    await expect(after).resolves.toBe('ran');
  });

  it('releases the key once the queue drains, so a later call starts fresh', async () => {
    await withKeyedLock('k', async () => 'first');
    await expect(withKeyedLock('k', async () => 'second')).resolves.toBe('second');
  });
});
