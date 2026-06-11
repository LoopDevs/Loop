import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

/**
 * A2-901 / ADR 036: handler-level coverage for the admin emission
 * endpoint — companion to `credits/__tests__/emissions.test.ts` which
 * pins the queue primitive. These tests pin the HTTP-surface invariants:
 * idempotency validation, body parsing, target-user lookup, asset
 * resolution, error mapping, replay path, envelope shape, and the
 * Discord audit fanout. Same mock-db / fake-context style as the
 * sibling refunds.test.ts.
 */

const {
  applyMock,
  guardMock,
  notifyMock,
  getUserByIdMock,
  payoutAssetForMock,
  generateMemoMock,
  EmissionAlreadyIssuedError,
  InsufficientBalanceError,
  DailyAdjustmentLimitError,
} = vi.hoisted(() => {
  class EmissionAlreadyIssuedError extends Error {
    constructor(public readonly payoutId: string) {
      super(`A matching active emission already exists for payout ${payoutId}`);
      this.name = 'EmissionAlreadyIssuedError';
    }
  }
  class InsufficientBalanceError extends Error {
    constructor(
      public readonly currency: string,
      public readonly balanceMinor: bigint,
      public readonly attemptedDelta: bigint,
    ) {
      super('Debit would drive balance below zero');
      this.name = 'InsufficientBalanceError';
    }
  }
  // ADM-01 (2026-06-30 cold audit): withdrawals now share the same
  // per-currency/per-day cap error class the adjustment/compensation
  // writers already throw.
  class DailyAdjustmentLimitError extends Error {
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
  }
  return {
    applyMock: vi.fn(),
    guardMock: vi.fn(),
    notifyMock: vi.fn(),
    getUserByIdMock: vi.fn(),
    payoutAssetForMock: vi.fn(),
    generateMemoMock: vi.fn(() => 'memo-fixed-for-tests'),
    EmissionAlreadyIssuedError,
    InsufficientBalanceError,
    DailyAdjustmentLimitError,
  };
});

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock('../idempotency.js', () => ({
  IDEMPOTENCY_KEY_MIN: 16,
  IDEMPOTENCY_KEY_MAX: 128,
  validateIdempotencyKey: (k: string | undefined): k is string =>
    k !== undefined && k.length >= 16 && k.length <= 128,
  withIdempotencyGuard: guardMock,
}));

vi.mock('../../credits/emissions.js', () => ({
  applyAdminEmission: applyMock,
  EmissionAlreadyIssuedError,
}));

vi.mock('../../credits/adjustments.js', () => ({
  InsufficientBalanceError,
  DailyAdjustmentLimitError,
}));

vi.mock('../../db/users.js', () => ({
  getUserById: getUserByIdMock,
}));

vi.mock('../../credits/payout-asset.js', () => ({
  payoutAssetFor: payoutAssetForMock,
}));

vi.mock('../../credits/payout-builder.js', () => ({
  generatePayoutMemo: generateMemoMock,
}));

vi.mock('../../discord.js', () => ({
  notifyAdminAudit: (args: unknown) => notifyMock(args),
}));

vi.mock('../../db/schema.js', () => ({
  HOME_CURRENCIES: ['USD', 'GBP', 'EUR'] as const,
}));

import { adminEmissionHandler } from '../emissions.js';

const VALID_USER_ID = '00000000-0000-0000-0000-000000000001';
const VALID_KEY = 'a'.repeat(32);
const VALID_DEST = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';

const GOOD_BODY = {
  amountMinor: '500',
  currency: 'USD',
  destinationAddress: VALID_DEST,
  reason: 'backfill of failed cashback payout — ticket #4081',
};

const APPLIED = {
  payoutId: 'payout-uuid',
  userId: VALID_USER_ID,
  currency: 'USD',
  amountMinor: 500n,
  balanceMinor: 1000n,
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
  guardMock.mockReset().mockImplementation(
    async (
      _args: unknown,
      doWrite: () => Promise<{
        status: number;
        body: Record<string, unknown>;
      }>,
    ) => {
      const result = await doWrite();
      return { ...result, replayed: false };
    },
  );
  notifyMock.mockReset();
  getUserByIdMock.mockReset().mockResolvedValue({ id: VALID_USER_ID, email: 'u@loop.test' });
  payoutAssetForMock.mockReset().mockReturnValue({ code: 'USDLOOP', issuer: 'GISSUER123' });
  generateMemoMock.mockReset().mockReturnValue('memo-fixed-for-tests');
});

describe('adminEmissionHandler — ADR-017 + ADR-024/036 invariants', () => {
  it('400 on non-UUID userId', async () => {
    const res = await adminEmissionHandler(makeCtx({ userId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('400 on missing Idempotency-Key (IDEMPOTENCY_KEY_REQUIRED)', async () => {
    const res = await adminEmissionHandler(makeCtx({ userId: VALID_USER_ID, body: GOOD_BODY }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('400 on too-short Idempotency-Key', async () => {
    const res = await adminEmissionHandler(
      makeCtx({ userId: VALID_USER_ID, body: GOOD_BODY, idempotencyKey: 'short' }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('401 when admin user context is missing (fail-closed on middleware gap)', async () => {
    const res = await adminEmissionHandler(
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
    const res = await adminEmissionHandler(
      makeCtx({ userId: VALID_USER_ID, body: '__throw__', idempotencyKey: VALID_KEY }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.message).toMatch(/valid JSON/);
  });

  it('400 when amountMinor is zero', async () => {
    const res = await adminEmissionHandler(
      makeCtx({
        userId: VALID_USER_ID,
        body: { ...GOOD_BODY, amountMinor: '0' },
        idempotencyKey: VALID_KEY,
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when amountMinor exceeds the 10M cap', async () => {
    const res = await adminEmissionHandler(
      makeCtx({
        userId: VALID_USER_ID,
        body: { ...GOOD_BODY, amountMinor: '10000001' },
        idempotencyKey: VALID_KEY,
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when currency is outside the USD/GBP/EUR enum', async () => {
    const res = await adminEmissionHandler(
      makeCtx({
        userId: VALID_USER_ID,
        body: { ...GOOD_BODY, currency: 'JPY' },
        idempotencyKey: VALID_KEY,
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when destinationAddress is not a Stellar pubkey', async () => {
    const res = await adminEmissionHandler(
      makeCtx({
        userId: VALID_USER_ID,
        body: { ...GOOD_BODY, destinationAddress: 'not-a-stellar-key' },
        idempotencyKey: VALID_KEY,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('404 when target user does not exist', async () => {
    getUserByIdMock.mockResolvedValueOnce(null);
    const res = await adminEmissionHandler(
      makeCtx({ userId: VALID_USER_ID, body: GOOD_BODY, idempotencyKey: VALID_KEY }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('503 NOT_CONFIGURED when the LOOP asset issuer is missing in env', async () => {
    payoutAssetForMock.mockReturnValueOnce({ code: 'USDLOOP', issuer: null });
    const res = await adminEmissionHandler(
      makeCtx({ userId: VALID_USER_ID, body: GOOD_BODY, idempotencyKey: VALID_KEY }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_CONFIGURED');
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('200 + envelope on happy path; converts minor→stroops, guard + notify fire once', async () => {
    applyMock.mockResolvedValueOnce(APPLIED);
    const res = await adminEmissionHandler(
      makeCtx({ userId: VALID_USER_ID, body: GOOD_BODY, idempotencyKey: VALID_KEY }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        payoutId: string;
        amountMinor: string;
        destinationAddress: string;
        balanceMinor: string;
      };
      audit: { replayed: boolean };
    };
    expect(body.result.payoutId).toBe('payout-uuid');
    expect(body.result.amountMinor).toBe('500');
    expect(body.result.destinationAddress).toBe(VALID_DEST);
    // ADR 036: the mirror balance is reported, not changed.
    expect(body.result.balanceMinor).toBe('1000');
    expect(body.audit.replayed).toBe(false);

    // Stroops = minor * 100_000; 500 * 100_000 = 50_000_000.
    expect(applyMock).toHaveBeenCalledOnce();
    const callArg = applyMock.mock.calls[0]?.[0] as {
      amountMinor: bigint;
      intent: { amountStroops: bigint; assetCode: string; assetIssuer: string; toAddress: string };
    };
    expect(callArg.amountMinor).toBe(500n);
    expect(callArg.intent.amountStroops).toBe(50_000_000n);
    expect(callArg.intent.assetCode).toBe('USDLOOP');
    expect(callArg.intent.assetIssuer).toBe('GISSUER123');
    expect(callArg.intent.toAddress).toBe(VALID_DEST);

    expect(guardMock).toHaveBeenCalledOnce();
    expect(notifyMock).toHaveBeenCalledOnce();
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ replayed: false, reason: GOOD_BODY.reason }),
    );
  });

  it('replays the stored snapshot on duplicate Idempotency-Key', async () => {
    const priorEnvelope = {
      result: {
        payoutId: 'payout-uuid',
        userId: VALID_USER_ID,
        currency: 'USD',
        amountMinor: '500',
        destinationAddress: VALID_DEST,
        balanceMinor: '1000',
        createdAt: APPLIED.createdAt.toISOString(),
      },
      audit: { replayed: true },
    };
    guardMock.mockResolvedValueOnce({ replayed: true, status: 200, body: priorEnvelope });

    const res = await adminEmissionHandler(
      makeCtx({ userId: VALID_USER_ID, body: GOOD_BODY, idempotencyKey: VALID_KEY }),
    );
    expect(res.status).toBe(200);
    expect(applyMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ replayed: true }));
  });

  it('400 INSUFFICIENT_BALANCE when the unbacked-emission guard rejects', async () => {
    applyMock.mockRejectedValueOnce(new InsufficientBalanceError('USD', 100n, 500n));
    const res = await adminEmissionHandler(
      makeCtx({ userId: VALID_USER_ID, body: GOOD_BODY, idempotencyKey: VALID_KEY }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INSUFFICIENT_BALANCE');
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('409 EMISSION_ALREADY_ISSUED when the semantic duplicate guard trips', async () => {
    applyMock.mockRejectedValueOnce(new EmissionAlreadyIssuedError('payout-uuid'));
    const res = await adminEmissionHandler(
      makeCtx({ userId: VALID_USER_ID, body: GOOD_BODY, idempotencyKey: VALID_KEY }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('EMISSION_ALREADY_ISSUED');
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('500 INTERNAL_ERROR on unexpected queue-layer failure', async () => {
    applyMock.mockRejectedValueOnce(new Error('unexpected DB timeout'));
    const res = await adminEmissionHandler(
      makeCtx({ userId: VALID_USER_ID, body: GOOD_BODY, idempotencyKey: VALID_KEY }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INTERNAL_ERROR');
  });
});
