/**
 * A2-1905 — deleteUserViaAnonymisation tests.
 *
 * Critical invariants (post-ADR-052 shape — the payout / credit-balance
 * blockers died with the credits ledger; the only remaining blocker is
 * an order mid-fulfilment):
 *   - blocks deletion when an order is mid-flight (`unpaid` / `paid`)
 *   - on success, the user's email is replaced with the synthetic
 *     placeholder and ctxUserId nulls out
 *   - identities are deleted, refresh tokens revoked
 *   - a revoke failure surfaces loudly (A4-086) after the writes
 *
 * Runs against the real in-memory document store; only the
 * refresh-token revoke is mocked (its own suite covers it).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { db, __resetDbForTests } from '../../db/client.js';
import type { OrderDoc, UserDoc } from '../../db/types.js';

const { revokeMock } = vi.hoisted(() => ({ revokeMock: vi.fn() }));
vi.mock('../../auth/refresh-tokens.js', () => ({
  revokeAllRefreshTokensForUser: (userId: string) => revokeMock(userId),
}));

import { deleteUserViaAnonymisation, deletedEmailFor } from '../dsr-delete.js';

beforeEach(() => {
  __resetDbForTests();
  revokeMock.mockReset();
  revokeMock.mockResolvedValue(undefined);
});

async function seedUser(overrides: Partial<UserDoc> = {}): Promise<UserDoc> {
  const now = new Date();
  const doc: UserDoc = {
    id: 'u-1',
    ctxUserId: 'ctx-1',
    email: 'real@b.com',
    tokenVersion: 0,
    homeCurrency: 'USD',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  await db.collection('users').insertOne(doc);
  return doc;
}

async function seedOrder(overrides: Partial<OrderDoc> = {}): Promise<OrderDoc> {
  const now = new Date();
  const doc: OrderDoc = {
    id: overrides.id ?? 'o-1',
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
    paymentCryptoCurrency: null,
    redeemCode: null,
    redeemPin: null,
    redeemUrl: null,
    redemptionBackfillAttempts: 0,
    redemptionBackfillLastAttemptAt: null,
    state: 'fulfilled',
    failureReason: null,
    idempotencyKey: null,
    createdAt: now,
    fulfilledAt: now,
    failedAt: null,
    ...overrides,
  };
  await db.collection('orders').insertOne(doc);
  return doc;
}

describe('deleteUserViaAnonymisation (A2-1905)', () => {
  it.each(['unpaid', 'paid'] as const)(
    'refuses with blockedBy=in_flight_orders when an order is %s',
    async (state) => {
      await seedUser();
      await seedOrder({ state });
      const out = await deleteUserViaAnonymisation('u-1');
      expect(out).toEqual({ ok: false, blockedBy: 'in_flight_orders' });
      // A block does NO writes and never revokes sessions.
      const user = await db.collection('users').findOne({ id: 'u-1' });
      expect(user?.email).toBe('real@b.com');
      expect(user?.ctxUserId).toBe('ctx-1');
      expect(revokeMock).not.toHaveBeenCalled();
    },
  );

  it.each(['fulfilled', 'rejected', 'refunded', 'expired'] as const)(
    'a terminal %s order does not block deletion',
    async (state) => {
      await seedUser();
      await seedOrder({ state });
      const out = await deleteUserViaAnonymisation('u-1');
      expect(out).toEqual({ ok: true });
    },
  );

  it("another user's in-flight order does not block deletion", async () => {
    await seedUser();
    await seedOrder({ id: 'o-other', userId: 'u-other', state: 'paid' });
    const out = await deleteUserViaAnonymisation('u-1');
    expect(out).toEqual({ ok: true });
  });

  it('on success, anonymises the doc, deletes identities, and revokes all refresh tokens', async () => {
    await seedUser();
    await db.collection('user_identities').insertOne({
      id: 'ident-1',
      userId: 'u-1',
      provider: 'google',
      providerSub: 'sub-1',
      emailAtLink: 'real@b.com',
      createdAt: new Date(),
    });
    // Another user's identity must survive.
    await db.collection('user_identities').insertOne({
      id: 'ident-2',
      userId: 'u-other',
      provider: 'google',
      providerSub: 'sub-2',
      emailAtLink: 'other@b.com',
      createdAt: new Date(),
    });

    const out = await deleteUserViaAnonymisation('u-1');
    expect(out).toEqual({ ok: true });

    // PII anchors gone: synthetic email, null ctxUserId.
    const user = await db.collection('users').findOne({ id: 'u-1' });
    expect(user?.email).toBe('deleted-u-1@deleted.loopfinance.io');
    expect(user?.ctxUserId).toBeNull();

    // OAuth links deleted — only for the target user.
    expect(await db.collection('user_identities').count({ userId: 'u-1' })).toBe(0);
    expect(await db.collection('user_identities').count({ userId: 'u-other' })).toBe(1);

    // Sessions dead.
    expect(revokeMock).toHaveBeenCalledWith('u-1');
  });

  it('A4-086: surfaces a revoke failure loudly AFTER the anonymisation writes land', async () => {
    await seedUser();
    revokeMock.mockRejectedValue(new Error('db down'));
    await expect(deleteUserViaAnonymisation('u-1')).rejects.toThrow('db down');
    // The anonymisation already landed — the failure must not roll it
    // back (operators re-run the revoke manually).
    const user = await db.collection('users').findOne({ id: 'u-1' });
    expect(user?.email).toBe(deletedEmailFor('u-1'));
  });

  it('deletedEmailFor produces a unique synthetic email per userId', () => {
    expect(deletedEmailFor('u-1')).toBe('deleted-u-1@deleted.loopfinance.io');
    expect(deletedEmailFor('u-1')).not.toEqual(deletedEmailFor('u-2'));
    // Synthetic email is well-formed for the email regex used in OTP request.
    expect(deletedEmailFor('u-1')).toMatch(/^[\w.+-]+@[\w.-]+\.\w+$/);
  });
});
