import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';

/**
 * CF-25 / X-PRIV-03 persistence test: proves the redeem code + PIN are
 * ciphertext *at rest* (the value stored in the document store) but
 * recoverable via the read-path decrypt. Exercises the real
 * `markOrderFulfilled` write against the real in-memory store, with
 * the envelope key set.
 */
const { envState } = vi.hoisted(() => ({
  envState: { LOOP_REDEEM_ENCRYPTION_KEY: undefined as string | undefined },
}));
// Partial env mock: only the redeem key is per-test mutable — the rest
// of the real (test-setup) env stays intact so logger/db keep booting.
vi.mock('../../env.js', async (importActual) => {
  const actual = (await importActual()) as { env: Record<string, unknown> };
  return {
    ...actual,
    get env() {
      return { ...actual.env, ...envState };
    },
  };
});

// 32-byte key, assigned into `envState` in `beforeEach` below.
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
  envState.LOOP_REDEEM_ENCRYPTION_KEY = KEY_B64;
  resetRedeemKeyCache();
});

/** Seeds a paid mirror doc ready to fulfil; returns its id. */
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

    // At rest: code + PIN are enveloped ciphertext, not the plaintext.
    expect(isEncryptedRedeemField(storedCode)).toBe(true);
    expect(storedCode.startsWith(REDEEM_ENVELOPE_PREFIX)).toBe(true);
    expect(storedCode).not.toContain('PLAINTEXT-GIFT-CODE');
    expect(isEncryptedRedeemField(storedPin)).toBe(true);
    expect(storedPin).not.toContain('4242');

    // URL stays plaintext (it's the landing page, not the secret).
    expect(stored.redeemUrl).toBe('https://merchant.example/redeem/abc');

    // The read path recovers the originals.
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
    envState.LOOP_REDEEM_ENCRYPTION_KEY = undefined;
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
