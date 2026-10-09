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
  markOrderFulfilled,
  markOrderPaid,
  markOrderRefunded,
  markOrderRejected,
  markOrderUnpaid,
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
    mirrorSyncedAt: null,
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

  it('returns null when the doc is already paid', async () => {
    const id = await seedOrder('paid');
    expect(await markOrderPaid(id)).toBeNull();
  });

  it('follows CTX out of expired, rejected and fulfilled, clearing the failure fields', async () => {
    for (const from of ['expired', 'rejected', 'refunded', 'fulfilled'] as const) {
      const id = await seedOrder(from, { failedAt: new Date(), failureReason: 'stale' });
      const r = await markOrderPaid(id);
      expect(r?.state).toBe('paid');
      const stored = await getOrder(id);
      expect(stored?.failedAt).toBeNull();
      expect(stored?.failureReason).toBeNull();
    }
  });
});

describe('markOrderUnpaid', () => {
  it('sets state=unpaid from any other state and clears the failure fields', async () => {
    for (const from of ['paid', 'fulfilled', 'rejected', 'refunded', 'expired'] as const) {
      const id = await seedOrder(from, { failedAt: new Date(), failureReason: 'stale' });
      const r = await markOrderUnpaid(id);
      expect(r?.state).toBe('unpaid');
      const stored = await getOrder(id);
      expect(stored?.failedAt).toBeNull();
      expect(stored?.failureReason).toBeNull();
    }
  });

  it('returns null when the doc is already unpaid', async () => {
    const id = await seedOrder('unpaid');
    expect(await markOrderUnpaid(id)).toBeNull();
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

  it('fulfils from expired, rejected and refunded, clearing the failure fields', async () => {
    for (const from of ['expired', 'rejected', 'refunded'] as const) {
      const id = await seedOrder(from, { failedAt: new Date(), failureReason: 'stale' });
      const r = await markOrderFulfilled(id, {
        redemption: { code: 'CODE-2', pin: null, url: null },
      });
      expect(r?.state).toBe('fulfilled');
      const stored = await getOrder(id);
      expect(stored?.failedAt).toBeNull();
      expect(stored?.failureReason).toBeNull();
      expect(stored?.redeemCode).toBe('CODE-2');
    }
  });

  it('returns null and keeps the stored redemption when already fulfilled', async () => {
    const id = await seedOrder('fulfilled', { redeemCode: 'KEEP' });
    expect(await markOrderFulfilled(id, {})).toBeNull();
    expect((await getOrder(id))?.redeemCode).toBe('KEEP');
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

  it('refunds from expired and rejected', async () => {
    for (const from of ['expired', 'rejected'] as const) {
      const id = await seedOrder(from);
      expect((await markOrderRefunded(id))?.state).toBe('refunded');
    }
  });

  it('returns null when the doc is already refunded', async () => {
    const id = await seedOrder('refunded');
    expect(await markOrderRefunded(id)).toBeNull();
  });
});
