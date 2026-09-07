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
 * covered by `redeem-crypto-persist.test.ts`. Runs against the real
 * in-memory document store.
 */

const KEY_B64 = randomBytes(32).toString('base64');
const { envState } = vi.hoisted(() => ({
  envState: { LOOP_REDEEM_ENCRYPTION_KEY: undefined as string | undefined },
}));
// Partial env mock: only the redeem key is per-test mutable.
vi.mock('../../env.js', async (importActual) => {
  const actual = (await importActual()) as { env: Record<string, unknown> };
  return {
    ...actual,
    get env() {
      return { ...actual.env, ...envState };
    },
  };
});

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { fetchRedemptionMock } = vi.hoisted(() => ({ fetchRedemptionMock: vi.fn() }));
vi.mock('../procurement-redemption.js', () => ({
  fetchRedemption: (ctxOrderId: string) => fetchRedemptionMock(ctxOrderId),
}));

vi.mock('../../discord.js', () => ({ notifyRedemptionBackfillExhausted: vi.fn() }));

import { db, __resetDbForTests } from '../../db/client.js';
import { resetRedeemKeyCache, isEncryptedRedeemField } from '../redeem-crypto.js';
import { runRedemptionBackfillTick } from '../redemption-backfill.js';

const NOW = 1_900_000_000_000;

beforeEach(() => {
  __resetDbForTests();
  fetchRedemptionMock.mockReset();
  envState.LOOP_REDEEM_ENCRYPTION_KEY = KEY_B64;
  resetRedeemKeyCache();
});

describe('redemption-backfill — persistRecoveredRedemption encrypts at rest (CF-25)', () => {
  it('stores ciphertext for code + PIN, plaintext for the URL', async () => {
    // A fulfilled doc that captured a ctxOrderId but no redemption
    // payload — the sweeper's candidate shape.
    await db.collection('orders').insertOne({
      id: 'order-1',
      userId: 'user-1',
      merchantId: 'merchant-1',
      faceValueMinor: 1000,
      currency: 'USD',
      chargeMinor: 1000,
      chargeCurrency: 'USD',
      userCashbackMinor: 0,
      expectedCommissionMinor: null,
      ctxOrderId: 'ctx-1',
      ctxPaymentId: null,
      paymentCryptoCurrency: 'XLM',
      redeemCode: null,
      redeemPin: null,
      redeemUrl: null,
      redemptionBackfillAttempts: 0,
      redemptionBackfillLastAttemptAt: null,
      state: 'fulfilled',
      failureReason: null,
      idempotencyKey: null,
      createdAt: new Date(NOW - 2 * 60 * 60 * 1000),
      fulfilledAt: new Date(NOW - 60 * 60 * 1000),
      failedAt: null,
    });
    fetchRedemptionMock.mockResolvedValueOnce({
      code: 'PLAINTEXT-GIFT-CODE',
      pin: '4242',
      url: 'https://merchant.example/redeem/abc',
    });

    const result = await runRedemptionBackfillTick({ now: NOW });
    expect(result.recovered).toBe(1);

    const stored = (await db.collection('orders').findOne({ id: 'order-1' }))!;
    expect(isEncryptedRedeemField(stored.redeemCode as string)).toBe(true);
    expect(stored.redeemCode).not.toBe('PLAINTEXT-GIFT-CODE');
    expect(isEncryptedRedeemField(stored.redeemPin as string)).toBe(true);
    expect(stored.redeemPin).not.toBe('4242');
    expect(stored.redeemUrl).toBe('https://merchant.example/redeem/abc');
  });
});
