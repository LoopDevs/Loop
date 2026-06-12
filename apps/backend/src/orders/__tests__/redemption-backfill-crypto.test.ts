import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';

/**
 * CF-25 / X-PRIV-03 persistence test for the redemption-backfill path.
 * `persistRecoveredRedemption` is shared by `runRedemptionBackfillTick`
 * and the ADR 037 `refetchOrderRedemption` admin one-shot — a prior
 * refactor pulling both call sites into that shared helper silently
 * dropped the `encryptRedeemField` wrapper (caught during PR #1430's
 * rebase review). This locks in that the shared helper still
 * encrypts, not just the primary `markOrderFulfilled` write path
 * covered by `redeem-crypto-persist.test.ts`.
 */

const KEY_B64 = randomBytes(32).toString('base64');
const { envState } = vi.hoisted(() => ({
  envState: { LOOP_REDEEM_ENCRYPTION_KEY: undefined as string | undefined },
}));
vi.mock('../../env.js', () => ({
  get env() {
    return envState;
  },
}));

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { fetchRedemptionMock } = vi.hoisted(() => ({ fetchRedemptionMock: vi.fn() }));
vi.mock('../procurement-redemption.js', () => ({
  fetchRedemption: (ctxOrderId: string) => fetchRedemptionMock(ctxOrderId),
}));

vi.mock('../../discord.js', () => ({ notifyRedemptionBackfillExhausted: vi.fn() }));

vi.mock('../../ctx/operator-pool.js', () => {
  class OperatorPoolUnavailableError extends Error {}
  class OperatorRateLimitedError extends Error {
    readonly retryAfterMs: number | null = null;
  }
  return { OperatorPoolUnavailableError, OperatorRateLimitedError };
});

const { dbMock, dbState } = vi.hoisted(() => {
  const s = { rows: [] as unknown[], lastSet: null as Record<string, unknown> | null };
  const selectChain: Record<string, unknown> = {};
  selectChain['from'] = vi.fn(() => selectChain);
  selectChain['where'] = vi.fn(() => selectChain);
  selectChain['orderBy'] = vi.fn(() => selectChain);
  selectChain['limit'] = vi.fn(async () => s.rows);
  const updateChain: Record<string, unknown> = {};
  updateChain['set'] = vi.fn((vals: Record<string, unknown>) => {
    s.lastSet = vals;
    return updateChain;
  });
  updateChain['where'] = vi.fn(() => updateChain);
  updateChain['returning'] = vi.fn(async () => [{ id: 'updated' }]);
  return {
    dbMock: { select: vi.fn(() => selectChain), update: vi.fn(() => updateChain) },
    dbState: s,
  };
});
vi.mock('../../db/client.js', () => ({ db: dbMock }));

import { resetRedeemKeyCache, isEncryptedRedeemField } from '../redeem-crypto.js';
import { runRedemptionBackfillTick } from '../redemption-backfill.js';

const NOW = 1_900_000_000_000;

beforeEach(() => {
  fetchRedemptionMock.mockReset();
  dbState.rows = [];
  dbState.lastSet = null;
  envState.LOOP_REDEEM_ENCRYPTION_KEY = KEY_B64;
  resetRedeemKeyCache();
});

describe('redemption-backfill — persistRecoveredRedemption encrypts at rest (CF-25)', () => {
  it('stores ciphertext for code + PIN, plaintext for the URL', async () => {
    dbState.rows = [
      {
        id: 'order-1',
        userId: 'user-1',
        merchantId: 'merchant-1',
        ctxOrderId: 'ctx-1',
        fulfilledAt: new Date(NOW - 60 * 60 * 1000),
        attempts: 0,
        lastAttemptAt: null,
      },
    ];
    fetchRedemptionMock.mockResolvedValueOnce({
      code: 'PLAINTEXT-GIFT-CODE',
      pin: '4242',
      url: 'https://merchant.example/redeem/abc',
    });

    await runRedemptionBackfillTick({ now: NOW });

    const set = dbState.lastSet!;
    expect(isEncryptedRedeemField(set['redeemCode'] as string)).toBe(true);
    expect(set['redeemCode']).not.toBe('PLAINTEXT-GIFT-CODE');
    expect(isEncryptedRedeemField(set['redeemPin'] as string)).toBe(true);
    expect(set['redeemPin']).not.toBe('4242');
    expect(set['redeemUrl']).toBe('https://merchant.example/redeem/abc');
  });
});
