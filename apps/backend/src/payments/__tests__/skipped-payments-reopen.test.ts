/**
 * reopenAbandonedSkip (ADR 037) — the support-action primitive.
 * Sibling of skipped-payments.test.ts (whose in-memory harness
 * models the sweep's setStatus/where-without-returning shape); this
 * file pins the reopen's guarded UPDATE: abandoned-only, attempts
 * reset, lastError cleared.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env['GIFT_CARD_API_BASE_URL'] = 'https://ctx.test';
  process.env['DATABASE_URL'] ??= 'postgres://placeholder@localhost/test';
});

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock('../../discord.js', () => ({
  notifyDepositSkipRecorded: vi.fn(),
  notifyDepositSkipAbandoned: vi.fn(),
}));

const { dbState } = vi.hoisted(() => ({
  dbState: {
    lastSet: null as Record<string, unknown> | null,
    matches: true,
    returningRows: [] as unknown[],
  },
}));

vi.mock('../../db/client.js', () => {
  const chain: Record<string, unknown> = {};
  chain['set'] = vi.fn((vals: Record<string, unknown>) => {
    dbState.lastSet = vals;
    return chain;
  });
  chain['where'] = vi.fn(() => chain);
  chain['returning'] = vi.fn(async () => (dbState.matches ? dbState.returningRows : []));
  return { db: { update: vi.fn(() => chain) } };
});

import { reopenAbandonedSkip } from '../skipped-payments.js';

beforeEach(() => {
  dbState.lastSet = null;
  dbState.matches = true;
  dbState.returningRows = [{ paymentId: '12345', attempts: 0 }];
});

describe('reopenAbandonedSkip', () => {
  it('resets the row to pending with a fresh budget and clears lastError', async () => {
    const out = await reopenAbandonedSkip('12345');
    expect(out).toEqual({ paymentId: '12345', attempts: 0 });
    expect(dbState.lastSet).toMatchObject({
      status: 'pending',
      attempts: 0,
      lastError: null,
    });
  });

  it('returns null when the row is not abandoned (guard did not match)', async () => {
    dbState.matches = false;
    const out = await reopenAbandonedSkip('12345');
    expect(out).toBeNull();
  });
});
