import { describe, it, expect } from 'vitest';
import { runWithRequestContext, getCurrentRequestId } from '../request-context.js';

describe('runWithRequestContext / getCurrentRequestId', () => {
  it('returns undefined outside a request', () => {
    expect(getCurrentRequestId()).toBeUndefined();
  });

  it('exposes the bound request ID inside the callback', async () => {
    await runWithRequestContext({ requestId: 'req-abc' }, async () => {
      expect(getCurrentRequestId()).toBe('req-abc');
    });
  });

  it('propagates through awaits, nested timers, and microtasks', async () => {
    await runWithRequestContext({ requestId: 'req-xyz' }, async () => {
      await Promise.resolve();
      expect(getCurrentRequestId()).toBe('req-xyz');
      await new Promise((r) => setTimeout(r, 0));
      expect(getCurrentRequestId()).toBe('req-xyz');
    });
  });

  it('isolates concurrent contexts — each request sees only its own ID', async () => {
    const seen: string[] = [];
    await Promise.all([
      runWithRequestContext({ requestId: 'a' }, async () => {
        await new Promise((r) => setTimeout(r, 1));
        seen.push(`a:${getCurrentRequestId() ?? 'none'}`);
      }),
      runWithRequestContext({ requestId: 'b' }, async () => {
        seen.push(`b:${getCurrentRequestId() ?? 'none'}`);
        await new Promise((r) => setTimeout(r, 1));
        seen.push(`b:${getCurrentRequestId() ?? 'none'}`);
      }),
    ]);
    expect(seen).toContain('a:a');
    expect(seen).toContain('b:b');
    // No cross-contamination
    expect(seen).not.toContain('a:b');
    expect(seen).not.toContain('b:a');
  });

  it('resolves the fn return value', async () => {
    const out = await runWithRequestContext({ requestId: 'r' }, () => 42);
    expect(out).toBe(42);
  });
});
