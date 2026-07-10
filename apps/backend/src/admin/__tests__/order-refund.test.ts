/**
 * Order-bound admin refund (A5-4). This file covers the HANDLER edge:
 * state-eligibility routing (paid/procuring/failed refund directly,
 * fulfilled requires the attestation, pending_payment/expired refused),
 * payment-method dispatch (xlm/usdc → on-chain, credit → mirror-credit,
 * loop_asset → fail-closed), the ctxPaid disambiguation for `procuring`,
 * the paid/procuring → failed fencing, error-code mapping, and
 * idempotent replay.
 *
 * The money-safety properties this handler *delegates to* (rather than
 * reimplements) are NOT re-tested here — INV-8 single-issue-per-order is
 * `applyAdminRefund` / `applyOnChainOrderAutoRefund`'s own partial-unique-
 * index + cross-check (covered in `credits/__tests__/refunds.test.ts`),
 * and the on-chain submit crash-safety is `payments/deposit-refund.ts`'s
 * (`payments/__tests__/deposit-refund.test.ts`). What IS proven here:
 * the handler dispatches to the RIGHT primitive for the order's
 * payment method, fences paid/procuring orders BEFORE refunding, and
 * never calls a refund primitive when a guard (attestation / ctxPaid /
 * unsupported method / bad state) trips.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const errors = vi.hoisted(() => {
  class RefundAlreadyIssuedError extends Error {
    constructor(public readonly orderId: string) {
      super(`A refund has already been issued for order ${orderId}`);
      this.name = 'RefundAlreadyIssuedError';
    }
  }
  class RefundOrderInvalidError extends Error {
    constructor(
      public readonly reason: string,
      message: string,
    ) {
      super(message);
      this.name = 'RefundOrderInvalidError';
    }
  }
  return { RefundAlreadyIssuedError, RefundOrderInvalidError };
});

const state = vi.hoisted(() => ({
  orders: new Map<string, Record<string, unknown>>(),
  orderSequence: [] as Array<Record<string, unknown> | null>,
  markFailedCalls: [] as Array<{ orderId: string; fromState: string; reason: string }>,
  markFailedReturnsNull: false,
  ctxPaid: false,
  applyAdminRefundCalls: [] as Array<Record<string, unknown>>,
  applyAdminRefundImpl: null as null | ((args: Record<string, unknown>) => Promise<unknown>),
  applyOrderAutoRefundCalls: [] as Array<Record<string, unknown>>,
  applyOrderAutoRefundImpl: null as null | ((args: Record<string, unknown>) => Promise<unknown>),
  snapshotStored: false,
  priorSnapshot: null as null | { status: number; body: Record<string, unknown> },
  discordCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../orders/repo.js', () => ({
  getOrderById: vi.fn(async (id: string) => {
    if (state.orderSequence.length > 0) return state.orderSequence.shift() ?? null;
    return state.orders.get(id) ?? null;
  }),
}));

vi.mock('../../orders/transitions.js', () => ({
  markOrderFailedFromState: vi.fn(async (orderId: string, fromState: string, reason: string) => {
    state.markFailedCalls.push({ orderId, fromState, reason });
    if (state.markFailedReturnsNull) return null;
    const existing = state.orders.get(orderId) ?? {};
    const updated = { ...existing, id: orderId, state: 'failed', failureReason: reason };
    state.orders.set(orderId, updated);
    return updated;
  }),
}));

vi.mock('../../orders/transitions-sweeps.js', () => ({
  loopPaidCtx: vi.fn(async () => state.ctxPaid),
}));

vi.mock('../../credits/refunds.js', () => ({
  RefundAlreadyIssuedError: errors.RefundAlreadyIssuedError,
  RefundOrderInvalidError: errors.RefundOrderInvalidError,
  applyAdminRefund: vi.fn(async (args: Record<string, unknown>) => {
    state.applyAdminRefundCalls.push(args);
    if (state.applyAdminRefundImpl !== null) return state.applyAdminRefundImpl(args);
    return {
      id: 'refund-row-1',
      userId: args.userId,
      currency: args.currency,
      amountMinor: args.amountMinor,
      orderId: args.orderId,
      priorBalanceMinor: 0n,
      newBalanceMinor: args.amountMinor,
      createdAt: new Date('2026-07-10T00:00:00Z'),
    };
  }),
  applyOrderAutoRefund: vi.fn(async (args: Record<string, unknown>) => {
    state.applyOrderAutoRefundCalls.push(args);
    if (state.applyOrderAutoRefundImpl !== null) return state.applyOrderAutoRefundImpl(args);
    return {
      kind: 'onchain_refund',
      orderId: args.orderId,
      paymentId: 'horizon-payment-1',
      refund: { kind: 'refunded', txHash: 'tx-hash-1' },
    };
  }),
}));

vi.mock('../../credits/adjustments.js', () => ({
  DailyAdjustmentLimitError: class DailyAdjustmentLimitError extends Error {
    constructor(
      public readonly currency: string,
      public readonly dayStartUtc: Date,
      public readonly usedMinor: bigint,
      public readonly capMinor: bigint,
      public readonly attemptedDelta: bigint,
    ) {
      super('Daily admin adjustment cap would be exceeded');
      this.name = 'DailyAdjustmentLimitError';
    }
  },
}));

vi.mock('../idempotency.js', () => ({
  IDEMPOTENCY_KEY_MIN: 16,
  IDEMPOTENCY_KEY_MAX: 128,
  validateIdempotencyKey: (k: string | undefined): k is string =>
    k !== undefined && k.length >= 16 && k.length <= 128,
  withIdempotencyGuard: vi.fn(
    async (
      _args: unknown,
      doWrite: () => Promise<{ status: number; body: Record<string, unknown> }>,
    ) => {
      if (state.priorSnapshot !== null) {
        return {
          replayed: true,
          status: state.priorSnapshot.status,
          body: state.priorSnapshot.body,
        };
      }
      const { status, body } = await doWrite();
      state.snapshotStored = true;
      return { replayed: false, status, body };
    },
  ),
}));

vi.mock('../../discord.js', () => ({
  notifyAdminAudit: vi.fn((args: Record<string, unknown>) => {
    state.discordCalls.push(args);
  }),
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminRefundOrderHandler } from '../order-refund.js';
import { markOrderFailedFromState } from '../../orders/transitions.js';
import { applyAdminRefund, applyOrderAutoRefund } from '../../credits/refunds.js';

const ORDER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const USER_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const actor = { id: '11111111-1111-1111-1111-111111111111', email: 'admin@loop.test' };
const validKey = 'k'.repeat(32);

function makeCtx(args: {
  orderId?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Context {
  const store = new Map<string, unknown>([['user', actor]]);
  return {
    req: {
      param: (k: string) => (k === 'orderId' ? (args.orderId ?? ORDER_ID) : undefined),
      header: (k: string) => args.headers?.[k.toLowerCase()],
      json: async () => {
        if (args.body === undefined) throw new Error('no body');
        return args.body;
      },
    },
    get: (k: string) => store.get(k),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

const refund = (over?: Partial<Parameters<typeof makeCtx>[0]>): Promise<Response> =>
  adminRefundOrderHandler(
    makeCtx({
      headers: { 'idempotency-key': validKey },
      body: { reason: 'customer requested a refund, order stuck' },
      ...over,
    }),
  );

function makeOrder(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: ORDER_ID,
    userId: USER_ID,
    state: 'paid',
    paymentMethod: 'xlm',
    chargeMinor: 500n,
    chargeCurrency: 'USD',
    paymentMemo: 'memo-1',
    paymentReceivedHorizonId: 'horizon-1',
    paymentReceivedPayment: { id: 'horizon-1' },
    ...overrides,
  };
}

beforeEach(() => {
  state.orders = new Map([[ORDER_ID, makeOrder()]]);
  state.orderSequence = [];
  state.markFailedCalls = [];
  state.markFailedReturnsNull = false;
  state.ctxPaid = false;
  state.applyAdminRefundCalls = [];
  state.applyAdminRefundImpl = null;
  state.applyOrderAutoRefundCalls = [];
  state.applyOrderAutoRefundImpl = null;
  state.snapshotStored = false;
  state.priorSnapshot = null;
  state.discordCalls = [];
  vi.mocked(markOrderFailedFromState).mockClear();
  vi.mocked(applyAdminRefund).mockClear();
  vi.mocked(applyOrderAutoRefund).mockClear();
});

describe('adminRefundOrderHandler — pre-fulfilment states dispatch by payment method', () => {
  it('200: paid + xlm → fences to failed, then on-chain refund', async () => {
    state.orders.set(ORDER_ID, makeOrder({ state: 'paid', paymentMethod: 'xlm' }));
    const res = await refund();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.result).toMatchObject({
      orderId: ORDER_ID,
      paymentMethod: 'xlm',
      refundMethod: 'onchain_deposit_refund',
      orderState: 'failed',
      attested: false,
      onChain: { txHash: 'tx-hash-1' },
      mirrorCredit: null,
    });
    expect(state.markFailedCalls).toHaveLength(1);
    expect(state.markFailedCalls[0]?.orderId).toBe(ORDER_ID);
    // Fence is pinned to the EXACT validated state (money review P2-1):
    // a `paid`-read order is fenced `WHERE state='paid'`, never with the
    // broad predicate that could fail a raced-into-`procuring` row.
    expect(state.markFailedCalls[0]?.fromState).toBe('paid');
    expect(state.applyOrderAutoRefundCalls).toHaveLength(1);
    expect(state.applyOrderAutoRefundCalls[0]).toMatchObject({
      orderId: ORDER_ID,
      paymentMethod: 'xlm',
      amountMinor: 500n,
      currency: 'USD',
    });
    expect(state.applyAdminRefundCalls).toHaveLength(0);
  });

  // A procuring order must be STALE (procured_at older than the recovery
  // sweep's 15-min cutoff) before it's refundable — closes the
  // live-worker TOCTOU. 20 min ago is comfortably past the 15-min bar.
  const STALE_PROCURED_AT = new Date(Date.now() - 20 * 60 * 1000);

  it('200: STALE procuring + usdc, CTX unpaid → fences to failed, then on-chain refund', async () => {
    state.orders.set(
      ORDER_ID,
      makeOrder({ state: 'procuring', paymentMethod: 'usdc', procuredAt: STALE_PROCURED_AT }),
    );
    state.ctxPaid = false;
    const res = await refund();
    expect(res.status).toBe(200);
    expect(state.markFailedCalls).toHaveLength(1);
    expect(state.applyOrderAutoRefundCalls).toHaveLength(1);
    expect(state.applyOrderAutoRefundCalls[0]?.paymentMethod).toBe('usdc');
  });

  it('400 ORDER_NOT_REFUNDABLE: FRESH procuring order (worker may be live) — refused, no ctxPaid check, no fence', async () => {
    state.orders.set(
      ORDER_ID,
      makeOrder({ state: 'procuring', paymentMethod: 'usdc', procuredAt: new Date() }),
    );
    state.ctxPaid = false;
    const res = await refund();
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('ORDER_NOT_REFUNDABLE');
    expect(state.markFailedCalls).toHaveLength(0);
    expect(state.applyOrderAutoRefundCalls).toHaveLength(0);
  });

  it('400 ORDER_NOT_REFUNDABLE: procuring order with null procured_at is treated as not-stale', async () => {
    state.orders.set(
      ORDER_ID,
      makeOrder({ state: 'procuring', paymentMethod: 'usdc', procuredAt: null }),
    );
    const res = await refund();
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('ORDER_NOT_REFUNDABLE');
    expect(state.markFailedCalls).toHaveLength(0);
  });

  it('409 ORDER_REFUND_CTX_ALREADY_PAID: STALE procuring + CTX already paid — refuses, no fence, no refund call', async () => {
    state.orders.set(
      ORDER_ID,
      makeOrder({ state: 'procuring', paymentMethod: 'usdc', procuredAt: STALE_PROCURED_AT }),
    );
    state.ctxPaid = true;
    const res = await refund();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('ORDER_REFUND_CTX_ALREADY_PAID');
    expect(state.markFailedCalls).toHaveLength(0);
    expect(state.applyOrderAutoRefundCalls).toHaveLength(0);
  });

  it('200: failed order (already terminal) → no fence call, refunds directly', async () => {
    state.orders.set(ORDER_ID, makeOrder({ state: 'failed', paymentMethod: 'xlm' }));
    const res = await refund();
    expect(res.status).toBe(200);
    expect(state.markFailedCalls).toHaveLength(0); // already terminal
    expect(state.applyOrderAutoRefundCalls).toHaveLength(1);
  });

  it('200: paid + credit → fences to failed, mirror-credit refund with the REAL admin actor', async () => {
    state.orders.set(ORDER_ID, makeOrder({ state: 'paid', paymentMethod: 'credit' }));
    const res = await refund();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.result).toMatchObject({
      refundMethod: 'mirror_credit',
      onChain: null,
      mirrorCredit: { newBalanceMinor: '500' },
    });
    expect(state.applyAdminRefundCalls).toHaveLength(1);
    expect(state.applyAdminRefundCalls[0]).toMatchObject({
      orderId: ORDER_ID,
      userId: USER_ID,
      currency: 'USD',
      amountMinor: 500n,
      adminUserId: actor.id, // NOT the synthetic system actor
    });
    expect(state.applyOrderAutoRefundCalls).toHaveLength(0);
  });

  it('409 ORDER_REFUND_UNSUPPORTED_PAYMENT_METHOD: loop_asset fails closed BEFORE any fence/refund call', async () => {
    state.orders.set(ORDER_ID, makeOrder({ state: 'paid', paymentMethod: 'loop_asset' }));
    const res = await refund();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe(
      'ORDER_REFUND_UNSUPPORTED_PAYMENT_METHOD',
    );
    expect(state.markFailedCalls).toHaveLength(0);
    expect(state.applyAdminRefundCalls).toHaveLength(0);
    expect(state.applyOrderAutoRefundCalls).toHaveLength(0);
  });

  it('loop_asset fails closed even for a fulfilled order (no attestation ever reached)', async () => {
    state.orders.set(ORDER_ID, makeOrder({ state: 'fulfilled', paymentMethod: 'loop_asset' }));
    const res = await refund();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe(
      'ORDER_REFUND_UNSUPPORTED_PAYMENT_METHOD',
    );
  });
});

describe('adminRefundOrderHandler — fulfilled orders require the code-unused attestation', () => {
  it('400 ORDER_REFUND_ATTESTATION_REQUIRED: fulfilled, no attestation in body', async () => {
    state.orders.set(ORDER_ID, makeOrder({ state: 'fulfilled', paymentMethod: 'xlm' }));
    const res = await refund();
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('ORDER_REFUND_ATTESTATION_REQUIRED');
    expect(state.applyOrderAutoRefundCalls).toHaveLength(0);
  });

  it('400 when attestation.codeUnused is not literal true', async () => {
    state.orders.set(ORDER_ID, makeOrder({ state: 'fulfilled', paymentMethod: 'xlm' }));
    const res = await refund({
      body: {
        reason: 'customer says code never worked',
        attestation: { codeUnused: false, attestationNote: 'tried the code, dead on arrival' },
      },
    });
    expect(res.status).toBe(400);
    expect(state.applyOrderAutoRefundCalls).toHaveLength(0);
  });

  it('200: fulfilled + valid attestation → refunds WITHOUT a state fence, attested=true, audit carries the attestation', async () => {
    state.orders.set(ORDER_ID, makeOrder({ state: 'fulfilled', paymentMethod: 'xlm' }));
    const res = await refund({
      body: {
        reason: 'redemption-backfill exhausted, code never delivered (R3-4)',
        attestation: {
          codeUnused: true,
          attestationNote: 'no redeem fields were ever populated on this order — nothing to use',
        },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.result).toMatchObject({ attested: true, orderState: 'fulfilled' });
    expect(state.markFailedCalls).toHaveLength(0); // fulfilled keeps its state
    expect(state.applyOrderAutoRefundCalls).toHaveLength(1);
    const passedReason = state.applyOrderAutoRefundCalls[0]?.reason as string;
    expect(passedReason).toContain('FULFILLED-ORDER REFUND');
    expect(passedReason).toContain('code-unused attestation confirmed');
    expect(state.discordCalls).toHaveLength(1);
    expect(state.discordCalls[0]?.reason).toContain('ATTESTATION');
    expect(state.discordCalls[0]?.reason).toContain('no redeem fields were ever populated');
  });
});

describe('adminRefundOrderHandler — already-refunded / ineligible states', () => {
  it('409 ORDER_ALREADY_REFUNDED when the underlying primitive reports a duplicate', async () => {
    state.orders.set(ORDER_ID, makeOrder({ state: 'failed', paymentMethod: 'credit' }));
    state.applyAdminRefundImpl = async () => {
      throw new errors.RefundAlreadyIssuedError(ORDER_ID);
    };
    const res = await refund();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('ORDER_ALREADY_REFUNDED');
  });

  it('404 when the order does not exist', async () => {
    state.orders = new Map();
    const res = await refund();
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_FOUND');
  });

  it.each(['pending_payment', 'expired'])(
    '400 ORDER_NOT_REFUNDABLE for %s — nothing was collected / already lapsed',
    async (badState) => {
      state.orders.set(ORDER_ID, makeOrder({ state: badState }));
      const res = await refund();
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('ORDER_NOT_REFUNDABLE');
      expect(state.markFailedCalls).toHaveLength(0);
      expect(state.applyOrderAutoRefundCalls).toHaveLength(0);
      expect(state.applyAdminRefundCalls).toHaveLength(0);
    },
  );

  it('409 when the fence races past us (order moved on between read and the state-pinned fence)', async () => {
    // Money review P2-1: a `paid`-read order that a worker claimed into
    // `procuring` in the gap → the pinned `WHERE state='paid'` fence
    // matches 0 rows → null → 409, refunding NOTHING (the worker goes on
    // to pay CTX; a broad-predicate fence would have double-lost here).
    state.orders.set(ORDER_ID, makeOrder({ state: 'paid', paymentMethod: 'xlm' }));
    state.markFailedReturnsNull = true;
    const res = await refund();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('ORDER_NOT_REFUNDABLE');
    expect(state.applyOrderAutoRefundCalls).toHaveLength(0);
    expect(state.applyAdminRefundCalls).toHaveLength(0);
    expect(state.snapshotStored).toBe(false); // never stored — retry-able with a fresh key
  });
});

describe('adminRefundOrderHandler — on-chain submit failure maps to 502, order stays fenced', () => {
  it('502 ORDER_REFUND_SUBMIT_FAILED when the on-chain primitive throws a non-typed error', async () => {
    state.orders.set(ORDER_ID, makeOrder({ state: 'paid', paymentMethod: 'xlm' }));
    state.applyOrderAutoRefundImpl = async () => {
      throw new Error('on-chain auto-refund did not complete: submit_failed');
    };
    const res = await refund();
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe('ORDER_REFUND_SUBMIT_FAILED');
    // The fence already committed before the refund attempt — a retry
    // via this SAME endpoint (order now 'failed') is safe.
    expect(state.markFailedCalls).toHaveLength(1);
  });
});

describe('adminRefundOrderHandler — request validation', () => {
  it('400 on bad orderId / missing idempotency key / missing reason', async () => {
    expect((await refund({ orderId: 'nope' })).status).toBe(400);
    expect((await refund({ headers: {} })).status).toBe(400);
    expect((await refund({ body: {} })).status).toBe(400);
    expect(state.applyOrderAutoRefundCalls).toHaveLength(0);
  });
});

describe('adminRefundOrderHandler — idempotency', () => {
  it('a same-key replay does NOT call the refund primitive a second time', async () => {
    state.orders.set(ORDER_ID, makeOrder({ state: 'paid', paymentMethod: 'xlm' }));
    const first = await refund();
    expect(first.status).toBe(200);
    expect(state.applyOrderAutoRefundCalls).toHaveLength(1);

    state.priorSnapshot = {
      status: 200,
      body: {
        result: {
          orderId: ORDER_ID,
          paymentMethod: 'xlm',
          refundMethod: 'onchain_deposit_refund',
          amountMinor: '500',
          currency: 'USD',
          orderState: 'failed',
          attested: false,
          onChain: { txHash: 'tx-hash-1' },
          mirrorCredit: null,
        },
        audit: {},
      },
    };

    const second = await refund();
    expect(second.status).toBe(200);
    expect(state.applyOrderAutoRefundCalls).toHaveLength(1); // still just one
    expect(state.discordCalls).toHaveLength(2); // audit fires on replay too
  });

  it('replays return the snapshot and mark the audit as replayed', async () => {
    state.priorSnapshot = {
      status: 200,
      body: {
        result: {
          orderId: ORDER_ID,
          paymentMethod: 'credit',
          refundMethod: 'mirror_credit',
          amountMinor: '500',
          currency: 'USD',
          orderState: 'failed',
          attested: false,
          onChain: null,
          mirrorCredit: { newBalanceMinor: '500' },
        },
        audit: { replayed: false },
      },
    };
    const res = await refund();
    expect(res.status).toBe(200);
    expect(state.applyAdminRefundCalls).toEqual([]);
    expect(state.applyOrderAutoRefundCalls).toEqual([]);
    expect(state.discordCalls[0]).toMatchObject({ replayed: true });
  });
});
