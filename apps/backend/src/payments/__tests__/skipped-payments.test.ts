import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HorizonPayment } from '../horizon.js';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const notifyRecordedMock = vi.fn();
const notifyAbandonedMock = vi.fn();
const notifyUnrecognizedMock = vi.fn();
vi.mock('../../discord/monitoring.js', () => ({
  notifyDepositSkipRecorded: (args: unknown) => notifyRecordedMock(args),
  notifyDepositSkipAbandoned: (args: unknown) => notifyAbandonedMock(args),
  // The throttle/roll-up inside the REAL notifier is asserted in
  // discord/__tests__/monitoring.test.ts (there the sendWebhook collapse
  // is countable). Here we mock it to assert recordSkip's ROUTING: an
  // unrecognized_deposit goes to this pager, not the per-row one.
  notifyUnrecognizedDepositRecorded: (args: unknown) => notifyUnrecognizedMock(args),
}));

// In-memory stand-in for the payment_watcher_skips table. Replicates
// the exact upsert semantics the module relies on (conflict on
// payment_id bumps attempts, setWhere status='pending' prevents
// reopening terminal rows) so the orchestration — alert gating,
// attempt budget, sweep routing — is exercised against realistic
// row state.
interface MemRow {
  paymentId: string;
  memo: string;
  orderId: string | null;
  reason: string;
  payment: unknown;
  attempts: number;
  lastError: string | null;
  status: 'pending' | 'resolved' | 'abandoned';
  createdAt: number;
}
const { mem } = vi.hoisted(() => ({ mem: { rows: new Map<string, MemRow>(), seq: 0 } }));

interface InsertChain {
  values: (v: Partial<MemRow> & { paymentId: string }) => InsertChain;
  onConflictDoUpdate: () => InsertChain;
  returning: () => Promise<Array<{ attempts: number }>>;
}
interface SelectChain {
  from: () => SelectChain;
  where: () => SelectChain;
  orderBy: () => SelectChain;
  limit: (n: number) => Promise<unknown[]>;
}
interface UpdateChain {
  set: (s: { status?: 'resolved' | 'abandoned' }) => UpdateChain;
  where: (cond: unknown) => Promise<void>;
}

vi.mock('../../db/client.js', () => {
  const insert = (): InsertChain => {
    let pending: Partial<MemRow> & { paymentId: string };
    const chain: InsertChain = {
      values: (v: typeof pending) => {
        pending = v;
        return chain;
      },
      onConflictDoUpdate: () => chain,
      returning: async () => {
        const existing = mem.rows.get(pending.paymentId);
        if (existing !== undefined) {
          if (existing.status !== 'pending') return [{ attempts: existing.attempts }];
          existing.attempts += 1;
          existing.reason = pending.reason ?? existing.reason;
          existing.lastError = pending.lastError ?? null;
          return [{ attempts: existing.attempts }];
        }
        const row: MemRow = {
          paymentId: pending.paymentId,
          memo: pending.memo ?? '',
          orderId: pending.orderId ?? null,
          reason: pending.reason ?? 'processing_error',
          payment: pending.payment,
          attempts: 1,
          lastError: pending.lastError ?? null,
          status: 'pending',
          createdAt: mem.seq++,
        };
        mem.rows.set(row.paymentId, row);
        return [{ attempts: 1 }];
      },
    };
    return chain;
  };
  const select = (): SelectChain => {
    const chain: SelectChain = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: async (n: number) =>
        [...mem.rows.values()]
          .filter((r) => r.status === 'pending')
          .sort((a, b) => a.createdAt - b.createdAt)
          .slice(0, n)
          .map((r) => ({
            paymentId: r.paymentId,
            memo: r.memo,
            orderId: r.orderId,
            reason: r.reason,
            payment: r.payment,
            attempts: r.attempts,
          })),
    };
    return chain;
  };
  const update = (): UpdateChain => {
    let setArgs: { status?: 'resolved' | 'abandoned' };
    const chain: UpdateChain = {
      set: (s: typeof setArgs) => {
        setArgs = s;
        return chain;
      },
      where: async (cond: unknown) => {
        // The module's only update is setStatus keyed on paymentId.
        // Drizzle's sql-template internals are private, so locate the
        // bound id structure-agnostically: the serialized condition
        // contains the parameter value.
        const seen = new WeakSet<object>();
        const serialized = JSON.stringify(cond, (_k, v: unknown) => {
          if (typeof v === 'bigint') return v.toString();
          if (typeof v === 'object' && v !== null) {
            if (seen.has(v)) return undefined;
            seen.add(v);
          }
          return v;
        });
        for (const row of mem.rows.values()) {
          if (serialized.includes(`"${row.paymentId}"`) && setArgs.status !== undefined) {
            row.status = setArgs.status;
          }
        }
      },
    };
    return chain;
  };
  return { db: { insert, select, update } };
});

import {
  recordSkip,
  retrySkippedPayments,
  MAX_SKIP_ATTEMPTS,
  type RetryOutcome,
} from '../skipped-payments.js';

function payment(id: string, memo = 'memo-1'): HorizonPayment {
  return {
    id,
    paging_token: `pt-${id}`,
    type: 'payment',
    to: 'GACCOUNT',
    asset_type: 'credit_alphanum4',
    asset_code: 'USDC',
    asset_issuer: 'GCENTRE',
    amount: '10.0000000',
    transaction_hash: `tx-${id}`,
    transaction: { memo, memo_type: 'text', successful: true },
  };
}

beforeEach(() => {
  mem.rows.clear();
  mem.seq = 0;
  notifyRecordedMock.mockReset();
  notifyAbandonedMock.mockReset();
  notifyUnrecognizedMock.mockReset();
});

describe('recordSkip', () => {
  it('alerts ops on the FIRST record of an investigation-grade reason', async () => {
    await recordSkip({
      payment: payment('p1'),
      memo: 'memo-1',
      orderId: 'order-1',
      reason: 'missing_credit_row',
    });
    expect(notifyRecordedMock).toHaveBeenCalledTimes(1);

    await recordSkip({
      payment: payment('p1'),
      memo: 'memo-1',
      orderId: 'order-1',
      reason: 'missing_credit_row',
    });
    // Retries bump attempts without re-paging.
    expect(notifyRecordedMock).toHaveBeenCalledTimes(1);
    expect(mem.rows.get('p1')?.attempts).toBe(2);
  });

  it('does NOT page for transient amount_insufficient skips', async () => {
    await recordSkip({
      payment: payment('p2'),
      memo: 'memo-2',
      orderId: 'order-2',
      reason: 'amount_insufficient',
    });
    expect(notifyRecordedMock).not.toHaveBeenCalled();
    expect(mem.rows.get('p2')?.status).toBe('pending');
  });

  it('AUDIT-2 finding C: routes unrecognized_deposit to the throttled pager, NOT the per-row one — and still writes every row', async () => {
    // A burst of unrecognized deposits (the public-deposit-address flood
    // vector). Each row must still be written to the DB unconditionally
    // (that's the /admin/skips recovery surface), and each first-record
    // must hit the THROTTLED notifier — never the per-row
    // notifyDepositSkipRecorded, which would flood the shared channel.
    const K = 25;
    for (let i = 0; i < K; i++) {
      await recordSkip({
        payment: payment(`u${i}`, `memo-u${i}`),
        memo: `memo-u${i}`,
        orderId: null,
        reason: 'unrecognized_deposit',
        detail: `unrecognized op u${i}`,
      });
    }
    // Every deposit got a durable row (recovery visibility is never
    // throttled — only the Discord page is).
    for (let i = 0; i < K; i++) {
      expect(mem.rows.get(`u${i}`)?.reason).toBe('unrecognized_deposit');
    }
    // Routed to the throttled pager (once per first-record), never the
    // per-row investigation pager.
    expect(notifyUnrecognizedMock).toHaveBeenCalledTimes(K);
    expect(notifyRecordedMock).not.toHaveBeenCalled();
  });

  it('AUDIT-2 finding C: a sweep RETRY of an unrecognized_deposit row does not re-page', async () => {
    await recordSkip({
      payment: payment('u-retry'),
      memo: 'memo-u-retry',
      orderId: null,
      reason: 'unrecognized_deposit',
      detail: 'first record',
    });
    expect(notifyUnrecognizedMock).toHaveBeenCalledTimes(1);
    // Same payment id again (attempts → 2): no re-page.
    await recordSkip({
      payment: payment('u-retry'),
      memo: 'memo-u-retry',
      orderId: null,
      reason: 'unrecognized_deposit',
      detail: 'retry',
    });
    expect(notifyUnrecognizedMock).toHaveBeenCalledTimes(1);
    expect(mem.rows.get('u-retry')?.attempts).toBe(2);
  });

  it('never reopens a terminal row', async () => {
    await recordSkip({
      payment: payment('p3'),
      memo: 'memo-3',
      orderId: null,
      reason: 'processing_error',
    });
    const row = mem.rows.get('p3');
    expect(row).toBeDefined();
    if (row !== undefined) row.status = 'resolved';

    await recordSkip({
      payment: payment('p3'),
      memo: 'memo-3',
      orderId: null,
      reason: 'processing_error',
    });
    expect(mem.rows.get('p3')?.status).toBe('resolved');
    expect(mem.rows.get('p3')?.attempts).toBe(1);
  });
});

describe('retrySkippedPayments', () => {
  it('resolves a row whose payment now marks the order paid', async () => {
    await recordSkip({
      payment: payment('p1'),
      memo: 'memo-1',
      orderId: 'order-1',
      reason: 'amount_insufficient',
    });
    const result = await retrySkippedPayments(async () => ({ kind: 'paid' }));
    expect(result).toEqual({ retried: 1, resolved: 1, abandoned: 0, stillPending: 0 });
    expect(mem.rows.get('p1')?.status).toBe('resolved');
  });

  it('abandons + pages when the order left pending_payment without this deposit', async () => {
    await recordSkip({
      payment: payment('p1'),
      memo: 'memo-1',
      orderId: 'order-1',
      reason: 'amount_insufficient',
    });
    const result = await retrySkippedPayments(async () => ({ kind: 'order_gone' }));
    expect(result.abandoned).toBe(1);
    expect(mem.rows.get('p1')?.status).toBe('abandoned');
    expect(notifyAbandonedMock).toHaveBeenCalledTimes(1);
  });

  it('bumps attempts on a repeat skip and abandons at the budget', async () => {
    await recordSkip({
      payment: payment('p1'),
      memo: 'memo-1',
      orderId: 'order-1',
      reason: 'amount_insufficient',
    });
    const row = mem.rows.get('p1');
    expect(row).toBeDefined();
    if (row !== undefined) row.attempts = MAX_SKIP_ATTEMPTS - 1;

    const outcome: RetryOutcome = {
      kind: 'skip',
      reason: 'amount_insufficient',
      orderId: 'order-1',
    };
    const result = await retrySkippedPayments(async () => outcome);
    expect(result.abandoned).toBe(1);
    expect(mem.rows.get('p1')?.status).toBe('abandoned');
    expect(notifyAbandonedMock).toHaveBeenCalledTimes(1);
  });

  it('isolates a row whose processing throws — neighbours still sweep', async () => {
    await recordSkip({
      payment: payment('p1', 'memo-1'),
      memo: 'memo-1',
      orderId: 'o1',
      reason: 'amount_insufficient',
    });
    await recordSkip({
      payment: payment('p2', 'memo-2'),
      memo: 'memo-2',
      orderId: 'o2',
      reason: 'amount_insufficient',
    });
    const result = await retrySkippedPayments(async (p) => {
      if (p.id === 'p1') throw new Error('boom');
      return { kind: 'paid' };
    });
    expect(result).toEqual({ retried: 2, resolved: 1, abandoned: 0, stillPending: 1 });
    expect(mem.rows.get('p1')?.status).toBe('pending');
    expect(mem.rows.get('p2')?.status).toBe('resolved');
  });

  it('abandons a snapshot that no longer parses instead of retrying forever', async () => {
    await recordSkip({
      payment: payment('p1'),
      memo: 'memo-1',
      orderId: null,
      reason: 'processing_error',
    });
    const row = mem.rows.get('p1');
    expect(row).toBeDefined();
    if (row !== undefined) row.payment = { not: 'a payment' };

    const result = await retrySkippedPayments(async () => ({ kind: 'paid' }));
    expect(result.abandoned).toBe(1);
    expect(mem.rows.get('p1')?.status).toBe('abandoned');
  });
});
