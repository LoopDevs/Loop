import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ConfigModule from '../../config/index.js';
import { randomBytes } from 'node:crypto';

// CF-25 / X-PRIV-03: locks in that the shared `persistRecoveredRedemption` helper still encrypts code/PIN, not just the primary `markOrderFulfilled` path.

const KEY_B64 = randomBytes(32).toString('base64');
const { redeemState } = vi.hoisted(() => ({
  redeemState: { key: undefined as string | undefined },
}));
// Only the redeem key is per-test mutable; the rest of the real config stays intact so logger/db keep booting.
vi.mock('../../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    get config() {
      return {
        ...actual.config,
        orders: { ...actual.config.orders, redeem: { encryptionKey: redeemState.key } },
      };
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
  redeemState.key = KEY_B64;
  resetRedeemKeyCache();
});

describe('redemption-backfill — persistRecoveredRedemption encrypts at rest (CF-25)', () => {
  it('stores ciphertext for code + PIN, plaintext for the URL', async () => {
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
