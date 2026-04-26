import { describe, it, expect } from 'vitest';
import {
  runWithRequestContext,
  getCurrentRequestId,
  setCtxResponseRequestId,
  getCtxResponseRequestId,
} from '../request-context.js';

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

describe('A2-1305 follow-up — CTX response request ID echo', () => {
  it('returns undefined outside a request', () => {
    expect(getCtxResponseRequestId()).toBeUndefined();
  });

  it('returns undefined when no CTX call has set the id', async () => {
    await runWithRequestContext({ requestId: 'inbound' }, async () => {
      expect(getCtxResponseRequestId()).toBeUndefined();
    });
  });

  it('records and returns the most recent CTX response id', async () => {
    await runWithRequestContext({ requestId: 'inbound' }, async () => {
      setCtxResponseRequestId('ctx-first');
      expect(getCtxResponseRequestId()).toBe('ctx-first');
      setCtxResponseRequestId('ctx-second');
      expect(getCtxResponseRequestId()).toBe('ctx-second');
    });
  });

  it('isolates ctx ids across concurrent inbound requests', async () => {
    const seen: string[] = [];
    await Promise.all([
      runWithRequestContext({ requestId: 'a' }, async () => {
        setCtxResponseRequestId('ctx-a');
        await new Promise((r) => setTimeout(r, 1));
        seen.push(`a:${getCtxResponseRequestId() ?? 'none'}`);
      }),
      runWithRequestContext({ requestId: 'b' }, async () => {
        setCtxResponseRequestId('ctx-b');
        await new Promise((r) => setTimeout(r, 1));
        seen.push(`b:${getCtxResponseRequestId() ?? 'none'}`);
      }),
    ]);
    expect(seen).toContain('a:ctx-a');
    expect(seen).toContain('b:ctx-b');
    expect(seen).not.toContain('a:ctx-b');
    expect(seen).not.toContain('b:ctx-a');
  });

  it('setCtxResponseRequestId is a no-op outside a request context', () => {
    expect(() => setCtxResponseRequestId('orphan')).not.toThrow();
    expect(getCtxResponseRequestId()).toBeUndefined();
  });
});
