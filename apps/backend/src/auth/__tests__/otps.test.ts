import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock, returned } = vi.hoisted(() => {
  const state: {
    insertedRow: unknown;
    selectRows: unknown[];
    updateRows: unknown[];
    deletedRows: unknown[];
    lastOp: 'insert' | 'delete' | null;
  } = { insertedRow: null, selectRows: [], updateRows: [], deletedRows: [], lastOp: null };
  const m: Record<string, ReturnType<typeof vi.fn>> = {};
  m['insert'] = vi.fn(() => {
    state.lastOp = 'insert';
    return m;
  });
  m['values'] = vi.fn(() => m);
  // `.returning()` serves both insert (single row) and delete (row
  // list) call sites — branch on which builder kicked off the chain.
  m['returning'] = vi.fn(async () =>
    state.lastOp === 'delete' ? state.deletedRows : [state.insertedRow],
  );
  m['delete'] = vi.fn(() => {
    state.lastOp = 'delete';
    return m;
  });
  m['select'] = vi.fn(() => m);
  m['from'] = vi.fn(() => m);
  // `.where` must stay chainable (findLiveOtp then .orderBy.limit)
  // AND awaitable (countRecentOtpsForEmail awaits it). Give it a
  // thenable property so both shapes work.
  m['where'] = vi.fn(() => {
    const chainable = {
      ...m,
      then: (resolve: (rows: unknown[]) => unknown) => resolve(state.selectRows),
    };
    return chainable;
  });
  m['orderBy'] = vi.fn(() => m);
  m['limit'] = vi.fn(async () => state.selectRows);
  m['update'] = vi.fn(() => m);
  m['set'] = vi.fn(() => m);
  return { dbMock: m, returned: state };
});

vi.mock('../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../db/schema.js', () => ({
  otps: {
    id: 'id',
    email: 'email',
    codeHash: 'codeHash',
    expiresAt: 'expiresAt',
    consumedAt: 'consumedAt',
    attempts: 'attempts',
    createdAt: 'createdAt',
  },
}));

import {
  generateOtpCode,
  hashOtpCode,
  createOtp,
  findLiveOtp,
  markOtpConsumed,
  countRecentOtpsForEmail,
  incrementOtpAttempts,
  purgeExpiredOtps,
  OTP_LENGTH,
} from '../otps.js';

beforeEach(() => {
  for (const fn of Object.values(dbMock)) {
    if (typeof fn === 'function' && 'mockClear' in fn) fn.mockClear();
  }
  returned.insertedRow = null;
  returned.selectRows = [];
  returned.deletedRows = [];
  returned.lastOp = null;
});

describe('generateOtpCode', () => {
  it('returns a zero-padded decimal of the configured length', () => {
    for (let i = 0; i < 20; i++) {
      const code = generateOtpCode();
      expect(code).toMatch(/^\d+$/);
      expect(code.length).toBe(OTP_LENGTH);
    }
  });
});

describe('hashOtpCode', () => {
  it('is deterministic for the same input', () => {
    expect(hashOtpCode('123456')).toBe(hashOtpCode('123456'));
  });
  it('differs across inputs', () => {
    expect(hashOtpCode('123456')).not.toBe(hashOtpCode('654321'));
  });
  it('produces a 64-char hex digest (sha256)', () => {
    expect(hashOtpCode('abc')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('createOtp', () => {
  it('inserts the hash (never the plaintext) and returns the inserted row shape', async () => {
    const expires = new Date('2030-01-01T00:00:00Z');
    returned.insertedRow = { id: 'row-1', expiresAt: expires };
    const out = await createOtp({ email: 'a@b.com', code: '123456' });
    expect(out).toEqual({ id: 'row-1', expiresAt: expires });
    expect(dbMock['values']!).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'a@b.com',
        codeHash: hashOtpCode('123456'),
      }),
    );
    const passedValues = dbMock['values']!.mock.calls[0]![0] as { codeHash: string };
    expect(passedValues.codeHash).not.toBe('123456');
  });

  it('throws if returning() yields no row', async () => {
    returned.insertedRow = undefined;
    await expect(createOtp({ email: 'a@b.com', code: '123456' })).rejects.toThrow(
      /no row returned/,
    );
  });
});

describe('findLiveOtp', () => {
  it('returns the row when a match exists', async () => {
    returned.selectRows = [{ id: 'r-1', attempts: 0 }];
    const r = await findLiveOtp({ email: 'a@b.com', code: '123456' });
    expect(r).toEqual({ id: 'r-1', attempts: 0 });
  });
  it('returns null when no match exists', async () => {
    returned.selectRows = [];
    const r = await findLiveOtp({ email: 'a@b.com', code: '000000' });
    expect(r).toBeNull();
  });
});

describe('markOtpConsumed', () => {
  it('issues an update against the provided row id', async () => {
    await markOtpConsumed('row-xyz');
    expect(dbMock['update']!).toHaveBeenCalled();
    expect(dbMock['set']!).toHaveBeenCalledWith(
      expect.objectContaining({ consumedAt: expect.any(Date) }),
    );
  });
});

describe('countRecentOtpsForEmail', () => {
  it('returns the count value from the aggregate row', async () => {
    returned.selectRows = [{ n: 3 }];
    const n = await countRecentOtpsForEmail({ email: 'a@b.com', windowMs: 60_000 });
    expect(n).toBe(3);
  });
  it('treats a missing row as 0', async () => {
    returned.selectRows = [];
    const n = await countRecentOtpsForEmail({ email: 'a@b.com', windowMs: 60_000 });
    expect(n).toBe(0);
  });
});

describe('incrementOtpAttempts', () => {
  it('issues the update — handler uses this on bad-code guess', async () => {
    await incrementOtpAttempts({ email: 'a@b.com' });
    expect(dbMock['update']!).toHaveBeenCalled();
    expect(dbMock['set']!).toHaveBeenCalled();
  });

  // CF2 AUTH-01 regression guard: the WHERE clause must scope by email +
  // live-row conditions only — no per-row LIMIT/subquery targeting the
  // single newest row, which is exactly the shape that let an attacker
  // dodge the attempts ceiling on an older code by requesting fresh OTPs.
  it('scopes the update to every live row for the email, not just the newest', async () => {
    await incrementOtpAttempts({ email: 'a@b.com' });
    expect(dbMock['limit']!).not.toHaveBeenCalled();
    expect(dbMock['orderBy']!).not.toHaveBeenCalled();
    const whereArg = dbMock['where']!.mock.calls[0]?.[0];
    const serialized = JSON.stringify(whereArg);
    // A drizzle `and(eq(...), isNull(...), gt(...))` composite never
    // contains a nested SELECT; the prior subquery-based implementation's
    // raw `sql` template did.
    expect(serialized).not.toMatch(/SELECT/i);
  });
});

describe('purgeExpiredOtps', () => {
  it('issues a delete and returns the deleted row count', async () => {
    returned.deletedRows = [{ id: 'r-1' }, { id: 'r-2' }, { id: 'r-3' }];
    const n = await purgeExpiredOtps({ retentionMs: 30 * 24 * 60 * 60 * 1000 });
    expect(dbMock['delete']!).toHaveBeenCalled();
    expect(n).toBe(3);
  });

  it('returns 0 when nothing matched', async () => {
    returned.deletedRows = [];
    const n = await purgeExpiredOtps({ retentionMs: 1000 });
    expect(n).toBe(0);
  });
});
