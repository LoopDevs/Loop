/**
 * Real-postgres integration test for the A6 refund CAS predicate.
 * The unit suite mocks the DB, so the money-critical claim WHERE —
 * `status='abandoned' OR (status='refunding' AND updated_at < NOW() -
 * 5min)` — and the concurrency of two racing claims are only exercised
 * here. This predicate is what makes the stale-reclaim safe (a fresh
 * refunding row is NOT re-claimed; a >5-min-stale one IS).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { paymentWatcherSkips } from '../../db/schema.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';
import { claimForRefund } from '../../payments/deposit-refund.js';

const PAYMENT = { id: 'op-1', type: 'payment', from: 'GSENDER', amount: '1.0000000' };

async function insertSkip(status: string, updatedAt: Date): Promise<void> {
  await db.insert(paymentWatcherSkips).values({
    paymentId: 'op-1',
    memo: 'MEMO',
    reason: 'processing_error',
    payment: PAYMENT,
    status: status as 'abandoned' | 'refunding',
    updatedAt,
  });
}

async function statusOf(): Promise<string> {
  const [row] = await db
    .select({ status: paymentWatcherSkips.status })
    .from(paymentWatcherSkips)
    .where(sql`${paymentWatcherSkips.paymentId} = 'op-1'`);
  return row!.status;
}

beforeAll(async () => {
  await ensureMigrated();
});
beforeEach(async () => {
  await truncateAllTables();
});

describe('claimForRefund (A6 CAS predicate)', () => {
  it('claims an abandoned row (abandoned → refunding)', async () => {
    await insertSkip('abandoned', new Date());
    expect(await claimForRefund('op-1')).toBe(true);
    expect(await statusOf()).toBe('refunding');
  });

  it('does NOT re-claim a FRESH refunding row', async () => {
    await insertSkip('refunding', new Date()); // just now
    expect(await claimForRefund('op-1')).toBe(false);
    expect(await statusOf()).toBe('refunding');
  });

  it('DOES re-claim a STALE refunding row (>5min old)', async () => {
    await insertSkip('refunding', new Date(Date.now() - 6 * 60 * 1000));
    expect(await claimForRefund('op-1')).toBe(true);
    expect(await statusOf()).toBe('refunding');
  });

  it('two concurrent claims: exactly one wins', async () => {
    await insertSkip('abandoned', new Date());
    const [a, b] = await Promise.all([claimForRefund('op-1'), claimForRefund('op-1')]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('never claims a refunded or resolved row', async () => {
    await insertSkip('refunded', new Date(Date.now() - 60 * 60 * 1000));
    expect(await claimForRefund('op-1')).toBe(false);
  });
});
