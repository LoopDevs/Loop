/**
 * A2-1906 — buildDsrExport tests.
 *
 * The handler-side wiring (auth, rate limit, content-disposition) is
 * covered by an integration-style mocked-fetch test in the same
 * suite. The bulk of the contract — what's included, what's redacted,
 * shape stability — is exercised against `buildDsrExport` directly so
 * a refactor to the handler doesn't silently degrade the export
 * payload. Runs against the real in-memory document store (schema
 * version 2: user / identities / orders — the credits/payout sections
 * died with the ledger under ADR 052).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db, __resetDbForTests } from '../../db/client.js';
import type { OrderDoc, UserDoc } from '../../db/types.js';
import { buildDsrExport, DSR_EXPORT_SCHEMA_VERSION } from '../dsr-export.js';

beforeEach(() => {
  __resetDbForTests();
});

const NOW = new Date('2026-04-26T12:34:56.000Z');

async function seedUser(overrides: Partial<UserDoc> = {}): Promise<UserDoc> {
  const doc: UserDoc = {
    id: 'u-1',
    ctxUserId: null,
    email: 'alice@example.com',
    tokenVersion: 0,
    homeCurrency: 'GBP',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
  await db.collection('users').insertOne(doc);
  return doc;
}

async function seedOrder(overrides: Partial<OrderDoc> = {}): Promise<OrderDoc> {
  const doc: OrderDoc = {
    id: overrides.id ?? 'o-1',
    userId: 'u-1',
    merchantId: 'm-1',
    faceValueMinor: 5000,
    currency: 'GBP',
    chargeMinor: 5000,
    chargeCurrency: 'GBP',
    userCashbackMinor: 250,
    expectedCommissionMinor: null,
    ctxOrderId: null,
    ctxPaymentId: null,
    paymentCryptoCurrency: null,
    redeemCode: null,
    redeemPin: null,
    redeemUrl: null,
    redemptionBackfillAttempts: 0,
    redemptionBackfillLastAttemptAt: null,
    state: 'unpaid',
    failureReason: null,
    idempotencyKey: null,
    createdAt: NOW,
    fulfilledAt: null,
    failedAt: null,
    ...overrides,
  };
  await db.collection('orders').insertOne(doc);
  return doc;
}

describe('buildDsrExport (A2-1906)', () => {
  it('returns null when the user does not exist', async () => {
    const out = await buildDsrExport('missing-id');
    expect(out).toBeNull();
  });

  it('includes the user doc, omits the redeem secrets, and reports redeemIssued correctly', async () => {
    await seedUser();
    await seedOrder({
      id: 'o-redeemed',
      state: 'fulfilled',
      ctxOrderId: 'ctx-x',
      redeemCode: 'SECRET-CODE-12345',
      redeemPin: 'SECRET-PIN-9999',
      fulfilledAt: NOW,
    });
    await seedOrder({ id: 'o-pending', merchantId: 'm2', state: 'unpaid' });
    // Another user's order must not appear at all.
    await seedOrder({ id: 'o-foreign', userId: 'u-other', state: 'fulfilled' });

    const out = await buildDsrExport('u-1');
    expect(out).not.toBeNull();
    if (out === null) throw new Error('unreachable');

    expect(out.schemaVersion).toBe(DSR_EXPORT_SCHEMA_VERSION);
    expect(out.user.email).toBe('alice@example.com');
    expect(out.orders).toHaveLength(2);

    const orderJson = JSON.stringify(out.orders);
    // Critical: the secret material must NOT leak even though we read
    // it from the stored doc to set `redeemIssued`.
    expect(orderJson).not.toContain('SECRET-CODE-12345');
    expect(orderJson).not.toContain('SECRET-PIN-9999');

    const redeemed = out.orders.find((o) => o.id === 'o-redeemed');
    const pending = out.orders.find((o) => o.id === 'o-pending');
    expect(redeemed?.redeemIssued).toBe(true);
    expect(pending?.redeemIssued).toBe(false);
  });

  it('serialises money fields as strings and dates as ISO strings (JSON-safe, shape-stable)', async () => {
    await seedUser();
    await seedOrder({
      id: 'o-money',
      state: 'fulfilled',
      faceValueMinor: 5000,
      chargeMinor: 4750,
      userCashbackMinor: 250,
      paymentCryptoCurrency: 'XLM',
      fulfilledAt: NOW,
    });
    const out = await buildDsrExport('u-1');
    expect(out).not.toBeNull();
    if (out === null) throw new Error('unreachable');

    const order = out.orders[0]!;
    expect(order.faceValueMinor).toBe('5000');
    expect(order.chargeMinor).toBe('4750');
    expect(order.userCashbackMinor).toBe('250');
    expect(order.paymentCryptoCurrency).toBe('XLM');
    expect(order.createdAt).toBe(NOW.toISOString());
    expect(order.fulfilledAt).toBe(NOW.toISOString());
    expect(order.failedAt).toBeNull();
    expect(out.user.createdAt).toBe(NOW.toISOString());
  });

  it('exposes the fallback contact + excluded list for off-host data sources', async () => {
    await seedUser({ ctxUserId: 'ctx-abc' });
    const out = await buildDsrExport('u-1');
    expect(out).not.toBeNull();
    if (out === null) throw new Error('unreachable');

    expect(out.notes.fallbackContact).toBe('privacy@loopfinance.io');
    expect(out.notes.excluded.length).toBeGreaterThan(0);
    // The exclusion list must mention CTX-side data and off-host
    // logs so a reader knows where else to ask.
    const all = out.notes.excluded.join(' ');
    expect(all).toMatch(/CTX/);
    expect(all).toMatch(/log/i);
  });

  it('user.ctxUserId is preserved (CTX mapping is part of the user-attributable data)', async () => {
    await seedUser({ ctxUserId: 'ctx-mapping-1234' });
    const out = await buildDsrExport('u-1');
    expect(out?.user.ctxUserId).toBe('ctx-mapping-1234');
  });

  it('passes through identities docs for the user only', async () => {
    await seedUser();
    await db.collection('user_identities').insertOne({
      id: 'id-1',
      userId: 'u-1',
      provider: 'google',
      providerSub: 'goog-sub-aaaa',
      emailAtLink: 'alice@example.com',
      createdAt: NOW,
    });
    await db.collection('user_identities').insertOne({
      id: 'id-2',
      userId: 'u-other',
      provider: 'apple',
      providerSub: 'apple-sub-bbbb',
      emailAtLink: 'other@example.com',
      createdAt: NOW,
    });
    const out = await buildDsrExport('u-1');
    expect(out?.identities).toHaveLength(1);
    expect(out?.identities[0]?.provider).toBe('google');
    expect(out?.identities[0]?.providerSub).toBe('goog-sub-aaaa');
    expect(out?.identities[0]?.createdAt).toBe(NOW.toISOString());
  });
});
