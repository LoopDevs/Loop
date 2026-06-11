import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock, state } = vi.hoisted(() => {
  const s: {
    findFirstResult: unknown;
    insertCalls: unknown[];
    updateSetArgs: unknown[];
    /** Rows the next `.returning()` resolves with (CAS win/lose). */
    returningRows: unknown[];
  } = { findFirstResult: null, insertCalls: [], updateSetArgs: [], returningRows: [] };
  const m: Record<string, ReturnType<typeof vi.fn>> = {};
  m['insert'] = vi.fn(() => m);
  m['values'] = vi.fn((v: unknown) => {
    s.insertCalls.push(v);
    return m;
  });
  m['update'] = vi.fn(() => m);
  m['set'] = vi.fn((v: unknown) => {
    s.updateSetArgs.push(v);
    return m;
  });
  // Drizzle's update chain is awaitable directly (`await ...where()`)
  // AND chainable into `.returning()` (used by tryRevokeIfLive's
  // compare-and-set). Mirror both shapes: a thenable that resolves
  // `[]`, carrying a `returning` that resolves `state.returningRows`.
  m['where'] = vi.fn(() => ({
    returning: vi.fn(async () => s.returningRows),
    then: (
      onFulfilled?: (value: unknown[]) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve<unknown[]>([]).then(onFulfilled, onRejected),
  }));
  const query = {
    refreshTokens: {
      findFirst: vi.fn(async () => s.findFirstResult),
    },
  };
  return { dbMock: { ...m, query }, state: s };
});

vi.mock('../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../db/schema.js', () => ({
  refreshTokens: {
    jti: 'jti',
    userId: 'userId',
    tokenHash: 'tokenHash',
    expiresAt: 'expiresAt',
    revokedAt: 'revokedAt',
    replacedByJti: 'replacedByJti',
    lastUsedAt: 'lastUsedAt',
  },
}));

import {
  hashRefreshToken,
  recordRefreshToken,
  findLiveRefreshToken,
  findRefreshTokenRecord,
  revokeRefreshToken,
  tryRevokeIfLive,
  revokeAllRefreshTokensForUser,
} from '../refresh-tokens.js';

beforeEach(() => {
  state.findFirstResult = null;
  state.insertCalls = [];
  state.updateSetArgs = [];
  state.returningRows = [];
  for (const [k, v] of Object.entries(dbMock)) {
    if (k === 'query') continue;
    if (typeof v === 'function' && 'mockClear' in v) {
      (v as unknown as { mockClear: () => void }).mockClear();
    }
  }
});

describe('hashRefreshToken', () => {
  it('is deterministic + 64-char hex', () => {
    const a = hashRefreshToken('token-a');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(hashRefreshToken('token-a'));
    expect(a).not.toBe(hashRefreshToken('token-b'));
  });
});

describe('recordRefreshToken', () => {
  it('inserts the hash, never the plaintext token', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    await recordRefreshToken({
      jti: 'jti-1',
      userId: 'user-uuid',
      token: 'super-secret-token',
      expiresAt,
    });
    expect(state.insertCalls).toHaveLength(1);
    const values = state.insertCalls[0] as Record<string, unknown>;
    expect(values['jti']).toBe('jti-1');
    expect(values['userId']).toBe('user-uuid');
    expect(values['tokenHash']).toBe(hashRefreshToken('super-secret-token'));
    expect(values['tokenHash']).not.toBe('super-secret-token');
  });
});

describe('findLiveRefreshToken', () => {
  it('returns null when no row matches the jti + live predicates', async () => {
    state.findFirstResult = undefined;
    const r = await findLiveRefreshToken({ jti: 'missing', token: 'anything' });
    expect(r).toBeNull();
  });

  it('returns null when the row exists but the hash does not match', async () => {
    state.findFirstResult = {
      jti: 'jti-1',
      tokenHash: hashRefreshToken('real-token'),
    };
    const r = await findLiveRefreshToken({ jti: 'jti-1', token: 'different-token' });
    expect(r).toBeNull();
  });

  it('returns the row when jti + hash match', async () => {
    const row = {
      jti: 'jti-1',
      userId: 'u-1',
      tokenHash: hashRefreshToken('real-token'),
    };
    state.findFirstResult = row;
    const r = await findLiveRefreshToken({ jti: 'jti-1', token: 'real-token' });
    expect(r).toBe(row);
  });
});

describe('revokeRefreshToken', () => {
  it('sets revokedAt, replacedByJti, and lastUsedAt', async () => {
    await revokeRefreshToken({ jti: 'jti-1', replacedByJti: 'jti-2' });
    expect(state.updateSetArgs).toHaveLength(1);
    const s = state.updateSetArgs[0] as Record<string, unknown>;
    expect(s['revokedAt']).toBeInstanceOf(Date);
    expect(s['replacedByJti']).toBe('jti-2');
    expect(s['lastUsedAt']).toBeInstanceOf(Date);
  });

  it('allows replacedByJti to be omitted (null)', async () => {
    await revokeRefreshToken({ jti: 'jti-1' });
    const s = state.updateSetArgs[0] as Record<string, unknown>;
    expect(s['replacedByJti']).toBeNull();
  });
});

describe('findRefreshTokenRecord', () => {
  it('returns the raw row even when revoked (A2-1608 reuse-signal lookup)', async () => {
    // findLiveRefreshToken filters revoked rows out; the reuse
    // detector needs the raw record to distinguish "revoked → theft
    // signal" from "never existed → forged".
    const revokedRow = {
      jti: 'jti-1',
      userId: 'user-uuid',
      tokenHash: hashRefreshToken('rotated-out-token'),
      revokedAt: new Date(),
      replacedByJti: 'jti-2',
    };
    state.findFirstResult = revokedRow;
    const r = await findRefreshTokenRecord('jti-1');
    expect(r).toBe(revokedRow);
  });

  it('returns null when the jti never existed (forged / cleaned-up token)', async () => {
    state.findFirstResult = undefined;
    const r = await findRefreshTokenRecord('never-issued');
    expect(r).toBeNull();
  });
});

describe('tryRevokeIfLive', () => {
  it('CAS win: returns true when the conditional update revoked the row, stamping successor metadata', async () => {
    // The UPDATE ... WHERE revoked_at IS NULL ... RETURNING hit the
    // (still-live) row — this caller owns the rotation.
    state.returningRows = [{ jti: 'jti-old' }];
    const won = await tryRevokeIfLive({ jti: 'jti-old', replacedByJti: 'jti-new' });
    expect(won).toBe(true);
    expect(state.updateSetArgs).toHaveLength(1);
    const set = state.updateSetArgs[0] as Record<string, unknown>;
    expect(set['revokedAt']).toBeInstanceOf(Date);
    expect(set['replacedByJti']).toBe('jti-new');
    expect(set['lastUsedAt']).toBeInstanceOf(Date);
  });

  it('CAS lose: returns false when a concurrent rotation already revoked the row', async () => {
    // RETURNING came back empty — `revoked_at IS NULL` no longer
    // matched, i.e. another request won the race first.
    state.returningRows = [];
    const won = await tryRevokeIfLive({ jti: 'jti-old', replacedByJti: 'jti-new' });
    expect(won).toBe(false);
  });

  it('allows replacedByJti to be omitted (null)', async () => {
    state.returningRows = [{ jti: 'jti-old' }];
    const won = await tryRevokeIfLive({ jti: 'jti-old' });
    expect(won).toBe(true);
    const set = state.updateSetArgs[0] as Record<string, unknown>;
    expect(set['replacedByJti']).toBeNull();
  });

  it('honours an explicit `now` for the revocation timestamp', async () => {
    const now = new Date('2026-06-11T00:00:00Z');
    state.returningRows = [{ jti: 'jti-old' }];
    await tryRevokeIfLive({ jti: 'jti-old', now });
    const set = state.updateSetArgs[0] as Record<string, unknown>;
    expect(set['revokedAt']).toBe(now);
    expect(set['lastUsedAt']).toBe(now);
  });
});

describe('revokeAllRefreshTokensForUser', () => {
  it('issues an update targeting only live rows for the user', async () => {
    await revokeAllRefreshTokensForUser('user-uuid');
    expect(state.updateSetArgs).toHaveLength(1);
    const s = state.updateSetArgs[0] as Record<string, unknown>;
    expect(s['revokedAt']).toBeInstanceOf(Date);
  });
});
