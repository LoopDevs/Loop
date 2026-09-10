import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ConfigModule from '../../config/index.js';
import { randomBytes, randomUUID } from 'node:crypto';

// CF-25 / X-PRIV-03: proves redeem code + PIN are ciphertext at rest but recoverable via read-path decrypt.
const { redeemState } = vi.hoisted(() => ({
  redeemState: { key: undefined as string | undefined },
}));
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

const KEY_B64 = randomBytes(32).toString('base64');

import { db, __resetDbForTests } from '../../db/client.js';
import type { OrderDoc } from '../../db/types.js';
import { markOrderFulfilled } from '../transitions.js';
import {
  decryptRedeemField,
  isEncryptedRedeemField,
  resetRedeemKeyCache,
  REDEEM_ENVELOPE_PREFIX,
} from '../redeem-crypto.js';

beforeEach(() => {
  __resetDbForTests();
  redeemState.key = KEY_B64;
  resetRedeemKeyCache();
});

async function seedPaidOrder(): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.collection('orders').insertOne({
    id,
    userId: 'u-1',
    merchantId: 'm-1',
    faceValueMinor: 1000,
    currency: 'USD',
    chargeMinor: 1000,
    chargeCurrency: 'USD',
    userCashbackMinor: 0,
    expectedCommissionMinor: null,
    ctxOrderId: null,
    ctxPaymentId: null,
    paymentCryptoCurrency: 'XLM',
    redeemCode: null,
    redeemPin: null,
    redeemUrl: null,
    redemptionBackfillAttempts: 0,
    redemptionBackfillLastAttemptAt: null,
    state: 'paid',
    failureReason: null,
    idempotencyKey: null,
    createdAt: now,
    fulfilledAt: null,
    failedAt: null,
  });
  return id;
}

async function getOrder(id: string): Promise<OrderDoc | null> {
  return db.collection('orders').findOne({ id });
}

describe('markOrderFulfilled — redeem secrets encrypted at rest', () => {
  it('persists code + PIN as ciphertext but leaves the URL plaintext', async () => {
    const id = await seedPaidOrder();
    await markOrderFulfilled(id, {
      redemption: {
        code: 'PLAINTEXT-GIFT-CODE',
        pin: '4242',
        url: 'https://merchant.example/redeem/abc',
      },
    });

    const stored = (await getOrder(id))!;
    const storedCode = stored.redeemCode as string;
    const storedPin = stored.redeemPin as string;

    expect(isEncryptedRedeemField(storedCode)).toBe(true);
    expect(storedCode.startsWith(REDEEM_ENVELOPE_PREFIX)).toBe(true);
    expect(storedCode).not.toContain('PLAINTEXT-GIFT-CODE');
    expect(isEncryptedRedeemField(storedPin)).toBe(true);
    expect(storedPin).not.toContain('4242');

    expect(stored.redeemUrl).toBe('https://merchant.example/redeem/abc');

    expect(decryptRedeemField(storedCode)).toBe('PLAINTEXT-GIFT-CODE');
    expect(decryptRedeemField(storedPin)).toBe('4242');
  });

  it('persists NULLs unchanged when there is no redemption payload', async () => {
    const id = await seedPaidOrder();
    await markOrderFulfilled(id, {});
    const stored = (await getOrder(id))!;
    expect(stored.redeemCode).toBeNull();
    expect(stored.redeemPin).toBeNull();
    expect(stored.redeemUrl).toBeNull();
  });

  it('with the key unset, stores plaintext (ships dark — backward compatible)', async () => {
    redeemState.key = undefined;
    resetRedeemKeyCache();
    const id = await seedPaidOrder();
    await markOrderFulfilled(id, {
      redemption: { code: 'DARK-MODE-CODE', pin: '9999', url: null },
    });
    const stored = (await getOrder(id))!;
    expect(stored.redeemCode).toBe('DARK-MODE-CODE');
    expect(stored.redeemPin).toBe('9999');
    expect(isEncryptedRedeemField(stored.redeemCode as string)).toBe(false);
  });
});
