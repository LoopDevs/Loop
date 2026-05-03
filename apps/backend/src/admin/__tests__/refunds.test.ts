import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

/**
 * A2-508: the admin refund handler was previously only exercised via
 * the credits-layer primitive test (`credits/__tests__/refunds.test.ts`)
 * which covers `applyAdminRefund` but not the HTTP surface — idempotency
 * validation, body parsing, envelope building, replay path, error mapping,
 * and the Discord audit fanout. Those are the ADR-017 invariants, and
 * they were uncovered.
 *
 * These tests pin them with the same mock-db / fake-context style as the
 * sibling cashback-config handler suite (`handler.test.ts`).
 */

const { applyMock, lookupMock, storeMock, notifyMock, RefundAlreadyIssuedError } = vi.hoisted(
  () => {
    class RefundAlreadyIssuedError extends Error {
      constructor(public readonly orderId: string) {
        super(`A refund has already been issued for order ${orderId}`);
        this.name = 'RefundAlreadyIssuedError';
      }
    }
    return {
      applyMock: vi.fn(),
      lookupMock: vi.fn(async () => null as null | { body: unknown; status: number }),
      storeMock: vi.fn(async () => undefined),
      notifyMock: vi.fn(),
      RefundAlreadyIssuedError,
    };
  },
);

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

// A4-019: handler now uses withIdempotencyGuard. The mock here
// emulates the production guard: lookup snapshot via lookupMock;
// if hit, return as replay; otherwise run doWrite and persist via
// storeMock. This preserves the lookupMock/storeMock test surface
// so existing assertions keep applying.
vi.mock('../idempotency.js', () => ({
  IDEMPOTENCY_KEY_MIN: 16,
  IDEMPOTENCY_KEY_MAX: 128,
  validateIdempotencyKey: (k: string | undefined): k is string =>
    k !== undefined && k.length >= 16 && k.length <= 128,
  withIdempotencyGuard: async (
    args: { adminUserId: string; key: string; method: string; path: string },
    doWrite: () => Promise<{ status: number; body: Record<string, unknown> }>,
  ): Promise<{ replayed: boolean; status: number; body: Record<string, unknown> }> => {
    const prior = await lookupMock(args);
    if (prior !== null) {
      const body = prior.body as { audit?: Record<string, unknown> };
      if (body.audit !== null && typeof body.audit === 'object') {
        body.audit['replayed'] = true;
      }
      return { replayed: true, status: prior.status, body: prior.body as Record<string, unknown> };
    }
    const { status, body } = await doWrite();
    await storeMock({
      adminUserId: args.adminUserId,
      key: args.key,
      method: args.method,
      path: args.path,
      status,
      body,
    });
    return { replayed: false, status, body };
  },
}));

vi.mock('../../credits/refunds.js', () => ({
  applyAdminRefund: applyMock,
  RefundAlreadyIssuedError,
}));

vi.mock('../../discord.js', () => ({
  notifyAdminAudit: (args: unknown) => notifyMock(args),
}));

vi.mock('../../db/schema.js', () => ({
  HOME_CURRENCIES: ['USD', 'GBP', 'EUR'] as const,
}));

import { adminRefundHandler } from '../refunds.js';

const VALID_USER_ID = '00000000-0000-0000-0000-000000000001';
const VALID_ORDER_ID = '00000000-0000-0000-0000-000000000002';
const VALID_KEY = 'a'.repeat(32);

const GOOD_BODY = {
  amountMinor: '500',
  currency: 'USD',
  orderId: VALID_ORDER_ID,
  reason: 'customer reported double-charge on support ticket #4032',
};

const APPLIED = {
  id: 'credit-tx-uuid',
  userId: VALID_USER_ID,
  currency: 'USD',
  amountMinor: 500n,
  orderId: VALID_ORDER_ID,
  priorBalanceMinor: 100n,
  newBalanceMinor: 600n,
  createdAt: new Date('2026-04-24T00:00:00Z'),
};

function makeCtx(opts: {
  userId?: string;
  body?: unknown;
  idempotencyKey?: string;
  actor?: { id: string; email?: string } | null;
}): Context {
  const store = new Map<string, unknown>();
  if (opts.actor !== null) {
    store.set('user', opts.actor ?? { id: 'admin-uuid', email: 'a@loop.test' });
  }
  const headers: Record<string, string | undefined> = {
    'idempotency-key': opts.idempotencyKey,
  };
  const params: Record<string, string | undefined> = { userId: opts.userId };
  return {
    req: {
      param: (k: string) => params[k],
      header: (k: string) => headers[k.toLowerCase()],
      json: async () => {
        if (opts.body === '__throw__') throw new Error('bad json');
        return opts.body;
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

beforeEach(() => {
  applyMock.mockReset();
  lookupMock.mockReset().mockResolvedValue(null);
  storeMock.mockReset().mockResolvedValue(undefined);
  notifyMock.mockReset();
});

describe('adminRefundHandler — ADR-017 invariants', () => {
  it('400 on non-UUID userId', async () => {
    const res = await adminRefundHandler(makeCtx({ userId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('400 on missing Idempotency-Key (IDEMPOTENCY_KEY_REQUIRED)', async () => {
    const res = await adminRefundHandler(
      makeCtx({ userId: VALID_USER_ID, body: GOOD_BODY /* no key */ }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('400 on too-short Idempotency-Key', async () => {
    const res = await adminRefundHandler(
      makeCtx({ userId: VALID_USER_ID, body: GOOD_BODY, idempotencyKey: 'short' }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('401 when admin user context is missing (fail-closed on middleware gap)', async () => {
    const res = await adminRefundHandler(
      makeCtx({
        userId: VALID_USER_ID,
        body: GOOD_BODY,
        idempotencyKey: VALID_KEY,
        actor: null,
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('400 when the request body is not valid JSON', async () => {
    const res = await adminRefundHandler(
      makeCtx({
        userId: VALID_USER_ID,
        body: '__throw__',
        idempotencyKey: VALID_KEY,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.message).toMatch(/valid JSON/);
  });

  it('400 when amountMinor is zero or negative (schema CHECK parity)', async () => {
    const res = await adminRefundHandler(
      makeCtx({
        userId: VALID_USER_ID,
        body: { ...GOOD_BODY, amountMinor: '0' },
        idempotencyKey: VALID_KEY,
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when amountMinor exceeds the 10M cap', async () => {
    const res = await adminRefundHandler(
      makeCtx({
        userId: VALID_USER_ID,
        body: { ...GOOD_BODY, amountMinor: '10000001' },
        idempotencyKey: VALID_KEY,
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when currency is outside the USD/GBP/EUR enum', async () => {
    const res = await adminRefundHandler(
      makeCtx({
        userId: VALID_USER_ID,
        body: { ...GOOD_BODY, currency: 'JPY' },
        idempotencyKey: VALID_KEY,
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when orderId is not a UUID', async () => {
    const res = await adminRefundHandler(
      makeCtx({
        userId: VALID_USER_ID,
        body: { ...GOOD_BODY, orderId: 'not-a-uuid' },
        idempotencyKey: VALID_KEY,
      }),
    );
    expect(res.status).toBe(400);
  });

  it('200 + envelope on happy path; store + notify fire once', async () => {
    applyMock.mockResolvedValueOnce(APPLIED);
    const res = await adminRefundHandler(
      makeCtx({ userId: VALID_USER_ID, body: GOOD_BODY, idempotencyKey: VALID_KEY }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { id: string; amountMinor: string };
      audit: { replayed: boolean };
    };
    expect(body.result.id).toBe('credit-tx-uuid');
    expect(body.result.amountMinor).toBe('500');
    expect(body.audit.replayed).toBe(false);
    expect(storeMock).toHaveBeenCalledOnce();
    expect(notifyMock).toHaveBeenCalledOnce();
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ replayed: false, reason: GOOD_BODY.reason }),
    );
  });

  it('replays the stored snapshot on duplicate Idempotency-Key', async () => {
    // Stored snapshot is BigInt-free — storeIdempotencyKey normalises
    // the envelope into Record<string, unknown> at write-time.
    const priorEnvelope = {
      result: {
        id: 'credit-tx-uuid',
        userId: VALID_USER_ID,
        currency: 'USD',
        amountMinor: '500',
        orderId: VALID_ORDER_ID,
        priorBalanceMinor: '100',
        newBalanceMinor: '600',
        createdAt: APPLIED.createdAt.toISOString(),
      },
      audit: { replayed: false },
    };
    lookupMock.mockResolvedValueOnce({ body: priorEnvelope, status: 200 });

    const res = await adminRefundHandler(
      makeCtx({ userId: VALID_USER_ID, body: GOOD_BODY, idempotencyKey: VALID_KEY }),
    );
    expect(res.status).toBe(200);
    expect(applyMock).not.toHaveBeenCalled();
    expect(storeMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ replayed: true }));
  });

  it('409 REFUND_ALREADY_ISSUED when the ledger layer raises the duplicate error', async () => {
    applyMock.mockRejectedValueOnce(new RefundAlreadyIssuedError(VALID_ORDER_ID));
    const res = await adminRefundHandler(
      makeCtx({ userId: VALID_USER_ID, body: GOOD_BODY, idempotencyKey: VALID_KEY }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('REFUND_ALREADY_ISSUED');
    expect(storeMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('500 INTERNAL_ERROR on unexpected ledger-layer failure', async () => {
    applyMock.mockRejectedValueOnce(new Error('unexpected DB timeout'));
    const res = await adminRefundHandler(
      makeCtx({ userId: VALID_USER_ID, body: GOOD_BODY, idempotencyKey: VALID_KEY }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INTERNAL_ERROR');
  });
});
