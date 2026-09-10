// `containsFilter` — document-store stand-in for SQL `ILIKE '%term%'`; escaping prevents regex injection from operator input
import { describe, it, expect, beforeEach } from 'vitest';
import { db, __resetDbForTests } from '../client.js';
import { containsFilter, escapeRegex, matchesFilter } from '../store.js';
import type { UserDoc } from '../types.js';

beforeEach(() => {
  __resetDbForTests();
});

async function seed(email: string): Promise<void> {
  const now = new Date();
  const doc: UserDoc = {
    id: email,
    ctxUserId: null,
    email,
    tokenVersion: 0,
    homeCurrency: 'USD',
    isAdmin: false,
    createdAt: now,
    updatedAt: now,
  };
  await db.collection('users').insertOne(doc);
}

describe('escapeRegex', () => {
  it('escapes every metacharacter so the term matches literally', () => {
    expect(new RegExp(escapeRegex('a.b')).test('axb')).toBe(false);
    expect(new RegExp(escapeRegex('a.b')).test('a.b')).toBe(true);
    expect(new RegExp(escapeRegex('(a+b)*')).test('(a+b)*')).toBe(true);
  });
});

describe('containsFilter', () => {
  it('matches a substring case-insensitively', async () => {
    await seed('Ada@Loop.test');
    await seed('bob@example.com');

    const hits = await db.collection('users').findMany({ email: containsFilter('LOOP') });
    expect(hits.map((u) => u.email)).toEqual(['Ada@Loop.test']);
  });

  it('does not treat the term as a pattern', async () => {
    await seed('axb@loop.test');
    const hits = await db.collection('users').findMany({ email: containsFilter('a.b') });
    expect(hits).toEqual([]);
  });

  it('never matches a null or non-string field', () => {
    expect(matchesFilter({ ctxUserId: null }, { ctxUserId: containsFilter('x') })).toBe(false);
    expect(matchesFilter({ n: 42 }, { n: containsFilter('4') } as never)).toBe(false);
  });
});
