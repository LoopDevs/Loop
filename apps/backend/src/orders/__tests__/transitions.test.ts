// Mirror-transition writer tests (ADR 052)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ConfigModule from '../../config/index.js';
import { randomUUID } from 'node:crypto';
import { db, __resetDbForTests } from '../../db/client.js';
import type { OrderDoc, OrderState } from '../../db/types.js';

const { redeemState } = vi.hoisted(() => ({
  redeemState: { key: undefined as string | undefined },
}));

// Partial config mock: only the redeem key is per-test mutable — the
// rest of the real (test-fixture) config stays intact so logger/db keep
// booting.
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

import { resetRedeemKeyCache } from '../redeem-crypto.js';
import {
  markOrderExpired,
  markOrderFulfilled,
  markOrderPaid,
  markOrderRefunded,
  markOrderRejected,
} from '../transitions.js';

beforeEach(() => {
  __resetDbForTests();
  redeemState.key = undefined;
  resetRedeemKeyCache();
});

/** Seeds a mirror doc in the given state; returns its id. */
async function seedOrder(state: OrderState, overrides: Partial<OrderDoc> = {}): Promise<string> {
  const id = overrides.id ?? randomUUID();
  const now = new Date();
  await db.collection('orders').insertOne({
    id,
    userId: 'u-1',
    merchantId: 'm-1',
    faceValueMinor: 1000,
    currency: 'USD',
    chargeMinor: 950,
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
    state,
    failureReason: null,
    idempotencyKey: null,
    createdAt: now,
    fulfilledAt: null,
    failedAt: null,
    ...overrides,
  });
  return id;
}

async function getOrder(id: string): Promise<OrderDoc | null> {
  return db.collection('orders').findOne({ id });
}

describe('markOrderPaid', () => {
  it('sets state=paid and returns the doc', async () => {
    const id = await seedOrder('unpaid');
    const r = await markOrderPaid(id);
    expect(r?.state).toBe('paid');
    expect((await getOrder(id))?.state).toBe('paid');
  });

  it('returns null when the guard does not match (already past unpaid)', async () => {
    const id = await seedOrder('fulfilled');
    expect(await markOrderPaid(id)).toBeNull();
    // A replayed event never regresses the mirror.
    expect((await getOrder(id))?.state).toBe('fulfilled');
  });
});

describe('markOrderFulfilled', () => {
  it('sets state, fulfilledAt, and the redemption payload (from paid)', async () => {
    const id = await seedOrder('paid');
    const r = await markOrderFulfilled(id, {
      redemption: { code: 'CODE-1', pin: '1234', url: 'https://redeem.example/x' },
    });
    expect(r?.state).toBe('fulfilled');
    const stored = await getOrder(id);
    expect(stored?.fulfilledAt).toBeInstanceOf(Date);
    expect(stored?.redeemUrl).toBe('https://redeem.example/x');
    // No encryption key in this test env → plaintext passthrough.
    expect(stored?.redeemCode).toBe('CODE-1');
    expect(stored?.redeemPin).toBe('1234');
  });

  it('a card can jump straight from unpaid when Loop missed the paid event', async () => {
    const id = await seedOrder('unpaid');
    const r = await markOrderFulfilled(id, {});
    expect(r?.state).toBe('fulfilled');
  });

  it('CF-25: encrypts code + pin at rest when the key is set, url stays plaintext', async () => {
    redeemState.key = Buffer.alloc(32, 7).toString('base64');
    const id = await seedOrder('paid');
    await markOrderFulfilled(id, {
      redemption: { code: 'SECRET-CODE', pin: '9999', url: 'https://redeem.example/y' },
    });
    const stored = await getOrder(id);
    expect(String(stored?.redeemCode)).toMatch(/^enc:v1:/);
    expect(String(stored?.redeemPin)).toMatch(/^enc:v1:/);
    expect(stored?.redeemCode).not.toContain('SECRET-CODE');
    expect(stored?.redeemUrl).toBe('https://redeem.example/y');
  });

  it('fulfils with null payload when the redemption fetch raced (backfill retries)', async () => {
    const id = await seedOrder('paid');
    await markOrderFulfilled(id, {});
    const stored = await getOrder(id);
    expect(stored?.redeemCode).toBeNull();
    expect(stored?.redeemPin).toBeNull();
    expect(stored?.redeemUrl).toBeNull();
  });

  it('returns null on a terminal doc (guard miss)', async () => {
    const id = await seedOrder('refunded');
    expect(await markOrderFulfilled(id, {})).toBeNull();
  });
});

describe('markOrderRejected', () => {
  it('sets state, failedAt, and the reason', async () => {
    const id = await seedOrder('unpaid');
    await markOrderRejected(id, 'rejected by supplier');
    const stored = await getOrder(id);
    expect(stored?.state).toBe('rejected');
    expect(stored?.failedAt).toBeInstanceOf(Date);
    expect(stored?.failureReason).toBe('rejected by supplier');
  });

  it('omits failureReason when null (keeps any earlier reason)', async () => {
    const id = await seedOrder('paid', { failureReason: 'earlier reason' });
    await markOrderRejected(id, null);
    const stored = await getOrder(id);
    expect(stored?.state).toBe('rejected');
    expect(stored?.failureReason).toBe('earlier reason');
  });
});

describe('markOrderRefunded', () => {
  it('sets state + failedAt — even from fulfilled (CTX can refund a delivered card)', async () => {
    for (const from of ['unpaid', 'paid', 'fulfilled'] as const) {
      const id = await seedOrder(from);
      const r = await markOrderRefunded(id);
      expect(r?.state).toBe('refunded');
      expect((await getOrder(id))?.failedAt).toBeInstanceOf(Date);
    }
  });

  it('returns null from expired (guard miss)', async () => {
    const id = await seedOrder('expired');
    expect(await markOrderRefunded(id)).toBeNull();
  });
});

describe('markOrderExpired', () => {
  it('sets state=expired with the payment-window reason', async () => {
    const id = await seedOrder('unpaid');
    await markOrderExpired(id);
    const stored = await getOrder(id);
    expect(stored?.state).toBe('expired');
    expect(stored?.failureReason).toBe('payment window expired');
  });

  it('returns null when the doc already left unpaid (paid event won)', async () => {
    const id = await seedOrder('paid');
    expect(await markOrderExpired(id)).toBeNull();
    expect((await getOrder(id))?.state).toBe('paid');
  });
});
