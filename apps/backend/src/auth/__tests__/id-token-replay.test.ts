import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { state, dbMock } = vi.hoisted(() => {
  const s: {
    inserted: Array<{ tokenHash: string }>;
    valuesCalls: unknown[];
    onConflictCalls: unknown[];
    throwOnReturning: Error | null;
  } = {
    inserted: [],
    valuesCalls: [],
    onConflictCalls: [],
    throwOnReturning: null,
  };
  const m: Record<string, unknown> = {};
  m['insert'] = vi.fn(() => m);
  m['values'] = vi.fn((v: unknown) => {
    s.valuesCalls.push(v);
    return m;
  });
  m['onConflictDoNothing'] = vi.fn((args: unknown) => {
    s.onConflictCalls.push(args);
    return m;
  });
  m['returning'] = vi.fn(async () => {
    if (s.throwOnReturning !== null) throw s.throwOnReturning;
    return s.inserted;
  });
  return { state: s, dbMock: m };
});

vi.mock('../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../db/schema.js', () => ({
  socialIdTokenUses: { tokenHash: 'token_hash' },
}));

import { consumeIdToken } from '../id-token-replay.js';

beforeEach(() => {
  state.inserted = [];
  state.valuesCalls = [];
  state.onConflictCalls = [];
  state.throwOnReturning = null;
});

describe('consumeIdToken', () => {
  it('returns true on fresh insert (no prior consumption)', async () => {
    state.inserted = [{ tokenHash: 'abcd' }];
    const ok = await consumeIdToken({
      token: 'eyJhbGciOiJSUzI1NiJ9.payload.sig',
      provider: 'google',
      expSeconds: 1_700_000_000,
    });
    expect(ok).toBe(true);
    // The hash, not the raw token, is persisted (defence-in-depth so we
    // don't keep claim content). Check the inserted shape.
    const inserted = state.valuesCalls[0] as {
      tokenHash: string;
      provider: string;
      expiresAt: Date;
    };
    expect(inserted.provider).toBe('google');
    expect(inserted.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(inserted.expiresAt.getTime()).toBe(1_700_000_000_000);
  });

  it('returns false when the conflict-do-nothing yields zero rows (replay)', async () => {
    state.inserted = []; // existing row → onConflictDoNothing returns nothing
    const ok = await consumeIdToken({
      token: 'eyJ.replay.sig',
      provider: 'apple',
      expSeconds: 1_700_000_999,
    });
    expect(ok).toBe(false);
  });

  it('hashes the same token to the same value (deterministic dedup)', async () => {
    state.inserted = [{ tokenHash: 'first' }];
    await consumeIdToken({ token: 'tok', provider: 'google', expSeconds: 0 });
    state.inserted = [{ tokenHash: 'second' }];
    await consumeIdToken({ token: 'tok', provider: 'google', expSeconds: 0 });
    const a = (state.valuesCalls[0] as { tokenHash: string }).tokenHash;
    const b = (state.valuesCalls[1] as { tokenHash: string }).tokenHash;
    expect(a).toBe(b);
  });

  it('different tokens produce different hashes', async () => {
    state.inserted = [{ tokenHash: 'one' }];
    await consumeIdToken({ token: 'A', provider: 'google', expSeconds: 0 });
    await consumeIdToken({ token: 'B', provider: 'google', expSeconds: 0 });
    const a = (state.valuesCalls[0] as { tokenHash: string }).tokenHash;
    const b = (state.valuesCalls[1] as { tokenHash: string }).tokenHash;
    expect(a).not.toBe(b);
  });

  it('rethrows DB errors (caller fails closed; attacker cannot ride Postgres blips)', async () => {
    state.throwOnReturning = new Error('connection refused');
    await expect(consumeIdToken({ token: 'x', provider: 'google', expSeconds: 0 })).rejects.toThrow(
      /connection refused/,
    );
  });
});
