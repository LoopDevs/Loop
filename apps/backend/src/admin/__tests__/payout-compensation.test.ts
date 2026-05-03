import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

/**
 * Handler-level coverage for the admin payout-compensation endpoint
 * (ADR-024 §5). Companion to the credits-layer primitive — these tests
 * pin the HTTP-surface invariants: idempotency validation, payout
 * lookup, kind/state guards, currency derivation from asset code,
 * stroops→minor conversion, error mapping, replay path, envelope
 * shape, and the Discord audit fanout.
 */

const {
  applyMock,
  lookupMock,
  storeMock,
  notifyMock,
  getPayoutMock,
  AlreadyCompensatedError,
  PayoutNotCompensableError,
} = vi.hoisted(() => {
  class AlreadyCompensatedError extends Error {
    constructor(public readonly payoutId: string) {
      super(`Payout ${payoutId} has already been compensated`);
      this.name = 'AlreadyCompensatedError';
    }
  }
  class PayoutNotCompensableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'PayoutNotCompensableError';
    }
  }
  return {
    applyMock: vi.fn(),
    // A4-099: lookupMock now drives the simulated snapshot-replay
    // path inside the withIdempotencyGuard mock below — when it
    // returns a value, the guard skips doWrite and replays.
    lookupMock: vi.fn(async () => null as null | { body: unknown; status: number }),
    // A4-099: storeMock is invoked by the guard mock after a fresh
    // doWrite to persist the snapshot. Tests assert it's called
    // with the right shape.
    storeMock: vi.fn(async () => undefined),
    notifyMock: vi.fn(),
    getPayoutMock: vi.fn(),
    AlreadyCompensatedError,
    PayoutNotCompensableError,
  };
});

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

// A4-099: handler now uses withIdempotencyGuard. The mock here
// emulates the production guard: lookup snapshot via lookupMock;
// if hit, return as replay; otherwise run doWrite and persist
// via storeMock. This preserves the lookupMock/storeMock test
// surface so existing assertions still apply.
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
      // Mirror production behaviour: bump audit.replayed=true on
      // the stored body so the wire contract matches the docs.
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

vi.mock('../../credits/payout-compensation.js', () => ({
  applyAdminPayoutCompensation: applyMock,
  AlreadyCompensatedError,
  PayoutNotCompensableError,
}));

vi.mock('../../credits/pending-payouts.js', () => ({
  getPayoutForAdmin: getPayoutMock,
}));

vi.mock('../../discord.js', () => ({
  notifyAdminAudit: (args: unknown) => notifyMock(args),
}));

import { adminPayoutCompensationHandler } from '../payout-compensation.js';

const VALID_PAYOUT_ID = '00000000-0000-0000-0000-000000000aaa';
const VALID_USER_ID = '00000000-0000-0000-0000-000000000111';
const VALID_KEY = 'a'.repeat(32);

const FAILED_WITHDRAWAL_PAYOUT = {
  id: VALID_PAYOUT_ID,
  userId: VALID_USER_ID,
  orderId: null,
  kind: 'withdrawal' as const,
  assetCode: 'USDLOOP',
  assetIssuer: 'GISSUER123',
  toAddress: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
  amountStroops: 50_000_000n, // 500 minor units
  memoText: 'memo',
  state: 'failed' as const,
  txHash: null,
  lastError: 'op_no_destination',
  attempts: 3,
  createdAt: new Date('2026-04-20T00:00:00Z'),
  submittedAt: new Date('2026-04-20T00:00:30Z'),
  confirmedAt: null,
  failedAt: new Date('2026-04-20T00:01:00Z'),
};

const APPLIED = {
  id: 'compensation-tx-uuid',
  payoutId: VALID_PAYOUT_ID,
  userId: VALID_USER_ID,
  currency: 'USD',
  amountMinor: 500n,
  priorBalanceMinor: 100n,
  newBalanceMinor: 600n,
  createdAt: new Date('2026-04-26T00:00:00Z'),
};

const GOOD_BODY = {
  reason: 'manual compensation — destination account does not exist on Stellar',
};

function makeCtx(opts: {
  payoutId?: string;
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
  const params: Record<string, string | undefined> = { id: opts.payoutId };
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
  applyMock.mockReset().mockResolvedValue(APPLIED);
  lookupMock.mockReset().mockResolvedValue(null);
  storeMock.mockReset().mockResolvedValue(undefined);
  notifyMock.mockReset();
  getPayoutMock.mockReset().mockResolvedValue(FAILED_WITHDRAWAL_PAYOUT);
});

describe('adminPayoutCompensationHandler — ADR-017 + ADR-024 §5 invariants', () => {
  it('400 on non-UUID payout id', async () => {
    const res = await adminPayoutCompensationHandler(makeCtx({ payoutId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('400 on missing Idempotency-Key', async () => {
    const res = await adminPayoutCompensationHandler(
      makeCtx({ payoutId: VALID_PAYOUT_ID, body: GOOD_BODY }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('400 on too-short Idempotency-Key', async () => {
    const res = await adminPayoutCompensationHandler(
      makeCtx({ payoutId: VALID_PAYOUT_ID, body: GOOD_BODY, idempotencyKey: 'short' }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('401 when admin user context is missing', async () => {
    const res = await adminPayoutCompensationHandler(
      makeCtx({
        payoutId: VALID_PAYOUT_ID,
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
    const res = await adminPayoutCompensationHandler(
      makeCtx({ payoutId: VALID_PAYOUT_ID, body: '__throw__', idempotencyKey: VALID_KEY }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.message).toMatch(/valid JSON/);
  });

  it('400 on empty / too-short reason', async () => {
    const res = await adminPayoutCompensationHandler(
      makeCtx({
        payoutId: VALID_PAYOUT_ID,
        body: { reason: 'a' },
        idempotencyKey: VALID_KEY,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('404 when the payout does not exist', async () => {
    getPayoutMock.mockResolvedValueOnce(null);
    const res = await adminPayoutCompensationHandler(
      makeCtx({ payoutId: VALID_PAYOUT_ID, body: GOOD_BODY, idempotencyKey: VALID_KEY }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('400 PAYOUT_NOT_COMPENSABLE when kind=order_cashback', async () => {
    getPayoutMock.mockResolvedValueOnce({
      ...FAILED_WITHDRAWAL_PAYOUT,
      kind: 'order_cashback',
      orderId: '00000000-0000-0000-0000-000000000bbb',
    });
    const res = await adminPayoutCompensationHandler(
      makeCtx({ payoutId: VALID_PAYOUT_ID, body: GOOD_BODY, idempotencyKey: VALID_KEY }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('PAYOUT_NOT_COMPENSABLE');
    expect(applyMock).not.toHaveBeenCalled();
  });

  it.each(['pending', 'submitted', 'confirmed'] as const)(
    "409 PAYOUT_NOT_COMPENSABLE when state='%s'",
    async (state) => {
      getPayoutMock.mockResolvedValueOnce({ ...FAILED_WITHDRAWAL_PAYOUT, state });
      const res = await adminPayoutCompensationHandler(
        makeCtx({ payoutId: VALID_PAYOUT_ID, body: GOOD_BODY, idempotencyKey: VALID_KEY }),
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe('PAYOUT_NOT_COMPENSABLE');
      expect(body.message).toContain(state);
      expect(applyMock).not.toHaveBeenCalled();
    },
  );

  it('500 INTERNAL_ERROR when payout has a non-LOOP asset code (defensive)', async () => {
    getPayoutMock.mockResolvedValueOnce({ ...FAILED_WITHDRAWAL_PAYOUT, assetCode: 'XLM' });
    const res = await adminPayoutCompensationHandler(
      makeCtx({ payoutId: VALID_PAYOUT_ID, body: GOOD_BODY, idempotencyKey: VALID_KEY }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(applyMock).not.toHaveBeenCalled();
  });

  it.each([
    ['USDLOOP', 'USD'],
    ['GBPLOOP', 'GBP'],
    ['EURLOOP', 'EUR'],
  ] as const)(
    'derives currency %s → %s and converts stroops/100_000 → minor',
    async (code, ccy) => {
      getPayoutMock.mockResolvedValueOnce({ ...FAILED_WITHDRAWAL_PAYOUT, assetCode: code });
      applyMock.mockResolvedValueOnce({ ...APPLIED, currency: ccy });
      const res = await adminPayoutCompensationHandler(
        makeCtx({ payoutId: VALID_PAYOUT_ID, body: GOOD_BODY, idempotencyKey: VALID_KEY }),
      );
      expect(res.status).toBe(200);
      const callArg = applyMock.mock.calls[0]?.[0] as {
        currency: string;
        amountMinor: bigint;
        payoutId: string;
      };
      expect(callArg.currency).toBe(ccy);
      expect(callArg.amountMinor).toBe(500n);
      expect(callArg.payoutId).toBe(VALID_PAYOUT_ID);
    },
  );

  it('200 + envelope on happy path; store + notify fire once', async () => {
    const res = await adminPayoutCompensationHandler(
      makeCtx({ payoutId: VALID_PAYOUT_ID, body: GOOD_BODY, idempotencyKey: VALID_KEY }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        id: string;
        payoutId: string;
        currency: string;
        amountMinor: string;
        priorBalanceMinor: string;
        newBalanceMinor: string;
      };
      audit: { replayed: boolean };
    };
    expect(body.result.id).toBe('compensation-tx-uuid');
    expect(body.result.payoutId).toBe(VALID_PAYOUT_ID);
    expect(body.result.currency).toBe('USD');
    expect(body.result.amountMinor).toBe('500');
    expect(body.result.priorBalanceMinor).toBe('100');
    expect(body.result.newBalanceMinor).toBe('600');
    expect(body.audit.replayed).toBe(false);
    expect(storeMock).toHaveBeenCalledOnce();
    expect(notifyMock).toHaveBeenCalledOnce();
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ replayed: false, reason: GOOD_BODY.reason }),
    );
  });

  it('replays the stored snapshot on duplicate Idempotency-Key', async () => {
    const priorEnvelope = {
      result: {
        id: 'compensation-tx-uuid',
        payoutId: VALID_PAYOUT_ID,
        userId: VALID_USER_ID,
        currency: 'USD',
        amountMinor: '500',
        priorBalanceMinor: '100',
        newBalanceMinor: '600',
        createdAt: APPLIED.createdAt.toISOString(),
      },
      audit: { replayed: false },
    };
    lookupMock.mockResolvedValueOnce({ body: priorEnvelope, status: 200 });

    const res = await adminPayoutCompensationHandler(
      makeCtx({ payoutId: VALID_PAYOUT_ID, body: GOOD_BODY, idempotencyKey: VALID_KEY }),
    );
    expect(res.status).toBe(200);
    expect(getPayoutMock).not.toHaveBeenCalled();
    expect(applyMock).not.toHaveBeenCalled();
    expect(storeMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ replayed: true }));
  });

  it('409 ALREADY_COMPENSATED when the ledger layer sees a late duplicate', async () => {
    applyMock.mockRejectedValueOnce(new AlreadyCompensatedError(VALID_PAYOUT_ID));
    const res = await adminPayoutCompensationHandler(
      makeCtx({ payoutId: VALID_PAYOUT_ID, body: GOOD_BODY, idempotencyKey: VALID_KEY }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('ALREADY_COMPENSATED');
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('409 PAYOUT_NOT_COMPENSABLE when the payout changed state after the initial read', async () => {
    applyMock.mockRejectedValueOnce(
      new PayoutNotCompensableError(
        "Payout is in state 'pending'; only 'failed' payouts can be compensated",
      ),
    );
    const res = await adminPayoutCompensationHandler(
      makeCtx({ payoutId: VALID_PAYOUT_ID, body: GOOD_BODY, idempotencyKey: VALID_KEY }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('PAYOUT_NOT_COMPENSABLE');
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('500 INTERNAL_ERROR on unexpected ledger-layer failure', async () => {
    applyMock.mockRejectedValueOnce(new Error('unexpected DB timeout'));
    const res = await adminPayoutCompensationHandler(
      makeCtx({ payoutId: VALID_PAYOUT_ID, body: GOOD_BODY, idempotencyKey: VALID_KEY }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(notifyMock).not.toHaveBeenCalled();
  });
});
