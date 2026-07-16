import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as AccountFreezeModule from '../../fraud/account-freeze.js';
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
  EmissionExceedsUnemittedBalanceError,
  InsufficientBalanceError,
  DailyAdjustmentLimitError,
} = vi.hoisted(() => {
  class EmissionAlreadyIssuedError extends Error {
    constructor(public readonly payoutId: string) {
      super(`A matching active emission already exists for payout ${payoutId}`);
      this.name = 'EmissionAlreadyIssuedError';
    }
  }
  // Hardening A1: cumulative conservation error — mirrors the real
  // class shape in credits/emissions.ts.
  class EmissionExceedsUnemittedBalanceError extends Error {
    constructor(
      public readonly currency: string,
      public readonly balanceMinor: bigint,
      public readonly alreadyEmittedMinor: bigint,
      public readonly requestedMinor: bigint,
    ) {
      super(
        `Emission of ${requestedMinor} minor would exceed the un-emitted liability: ` +
          `mirror balance ${balanceMinor} minus ${alreadyEmittedMinor} already materialised on-chain`,
      );
      this.name = 'EmissionExceedsUnemittedBalanceError';
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
    EmissionExceedsUnemittedBalanceError,
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
  EmissionExceedsUnemittedBalanceError,
}));

vi.mock('../../credits/adjustments.js', () => ({
  InsufficientBalanceError,
  DailyAdjustmentLimitError,
}));

vi.mock('../../db/users.js', () => ({
  getUserById: getUserByIdMock,
}));

// NS-08: neutralize the account-freeze read for these unit tests (target
// not-frozen by default) — the emission #10 freeze block is covered
// end-to-end in the integration suite. Keeps the real errors/helpers.
vi.mock('../../fraud/account-freeze.js', async (importActual) => {
  const actual = await importActual<typeof AccountFreezeModule>();
  return { ...actual, isFrozenForIntent: vi.fn(async () => false) };
});

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
  // MNY-10: the target user's registered wallet is `VALID_DEST` (the
  // address `GOOD_BODY.destinationAddress` supplies), so the pinning
  // guard is a no-op on the happy paths. Tests that exercise the guard
  // override this mock per-case.
  getUserByIdMock.mockReset().mockResolvedValue({
    id: VALID_USER_ID,
    email: 'u@loop.test',
    walletProvisioning: 'activated',
    walletAddress: VALID_DEST,
    stellarAddress: null,
  });
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

  it('400 DESTINATION_NOT_REGISTERED when destinationAddress is not the user registered wallet (MNY-10)', async () => {
    // User's registered wallet differs from the supplied destination.
    getUserByIdMock.mockResolvedValueOnce({
      id: VALID_USER_ID,
      email: 'u@loop.test',
      walletProvisioning: 'activated',
      walletAddress: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI',
      stellarAddress: null,
    });
    const res = await adminEmissionHandler(
      makeCtx({ userId: VALID_USER_ID, body: GOOD_BODY, idempotencyKey: VALID_KEY }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('DESTINATION_NOT_REGISTERED');
    // The disease-proof: the queue write never fired for the wrong dest.
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('400 NO_REGISTERED_WALLET when the target user has no registered wallet (MNY-10)', async () => {
    getUserByIdMock.mockResolvedValueOnce({
      id: VALID_USER_ID,
      email: 'u@loop.test',
      walletProvisioning: 'none',
      walletAddress: null,
      stellarAddress: null,
    });
    const res = await adminEmissionHandler(
      makeCtx({ userId: VALID_USER_ID, body: GOOD_BODY, idempotencyKey: VALID_KEY }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NO_REGISTERED_WALLET');
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('pins the destination to a legacy linked stellarAddress when there is no activated embedded wallet (MNY-10)', async () => {
    // Embedded wallet exists but is NOT activated (no trustlines) →
    // resolution falls back to the legacy linked address, mirroring the
    // cashback payout builder. An emission to that address is accepted.
    getUserByIdMock.mockResolvedValueOnce({
      id: VALID_USER_ID,
      email: 'u@loop.test',
      walletProvisioning: 'wallet_created',
      walletAddress: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI',
      stellarAddress: VALID_DEST,
    });
    applyMock.mockResolvedValueOnce(APPLIED);
    const res = await adminEmissionHandler(
      makeCtx({ userId: VALID_USER_ID, body: GOOD_BODY, idempotencyKey: VALID_KEY }),
    );
    expect(res.status).toBe(200);
    const callArg = applyMock.mock.calls[0]?.[0] as { intent: { toAddress: string } };
    expect(callArg.intent.toAddress).toBe(VALID_DEST);
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

  it('409 EMISSION_EXCEEDS_UNEMITTED_BALANCE when cumulative conservation rejects (hardening A1)', async () => {
    applyMock.mockRejectedValueOnce(
      new EmissionExceedsUnemittedBalanceError('USD', 2000n, 1500n, 800n),
    );
    const res = await adminEmissionHandler(
      makeCtx({ userId: VALID_USER_ID, body: GOOD_BODY, idempotencyKey: VALID_KEY }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('EMISSION_EXCEEDS_UNEMITTED_BALANCE');
    // The operator sees the remaining headroom in the message.
    expect(body.message).toContain('1500');
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('429 DAILY_LIMIT_EXCEEDED when the fleet-wide emission cap trips (hardening A1)', async () => {
    applyMock.mockRejectedValueOnce(
      new DailyAdjustmentLimitError('USD', new Date(), 90_000_000n, 100_000_000n, 20_000_000n),
    );
    const res = await adminEmissionHandler(
      makeCtx({ userId: VALID_USER_ID, body: GOOD_BODY, idempotencyKey: VALID_KEY }),
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('DAILY_LIMIT_EXCEEDED');
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
