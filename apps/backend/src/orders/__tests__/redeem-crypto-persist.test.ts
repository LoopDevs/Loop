import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';

/**
 * CF-25 / X-PRIV-03 persistence test: proves the redeem code + PIN are
 * ciphertext *on disk* (the value handed to the DB `.set()`) but
 * recoverable via the read-path decrypt. Exercises the real
 * `markOrderFulfilled` write through a captured db chain, with the
 * envelope key set.
 */

// 32-byte key, set before the modules load.
const KEY_B64 = randomBytes(32).toString('base64');
const envState = { LOOP_REDEEM_ENCRYPTION_KEY: KEY_B64 as string | undefined };
vi.mock('../../env.js', () => ({
  get env() {
    return envState;
  },
}));

// Minimal chainable db mock that records the order-update `.set()`
// payload. The fulfillment txn also inserts ledger rows + looks up the
// user; we stub those to no-ops since this test only cares about the
// order update's redeem fields.
const { dbMock, state } = vi.hoisted(() => {
  const s: { updateSet: Record<string, unknown> | undefined } = { updateSet: undefined };
  const chain: Record<string, unknown> = {};
  chain['update'] = vi.fn(() => chain);
  chain['set'] = vi.fn((v: Record<string, unknown>) => {
    s.updateSet = v;
    return chain;
  });
  chain['where'] = vi.fn(() => chain);
  chain['returning'] = vi.fn(async () => [
    {
      id: 'o-1',
      userId: 'u-1',
      merchantId: 'm-1',
      currency: 'USD',
      chargeCurrency: 'USD',
      userCashbackMinor: 0n, // 0 → skips ledger writes, keeps the test focused
      faceValueMinor: 1_000n,
      chargeMinor: 1_000n,
      state: 'fulfilled',
    },
  ]);
  chain['insert'] = vi.fn(() => chain);
  chain['values'] = vi.fn(() => chain);
  chain['onConflictDoUpdate'] = vi.fn(() => chain);
  chain['onConflictDoNothing'] = vi.fn(() => chain);
  chain['select'] = vi.fn(() => chain);
  chain['from'] = vi.fn(() => chain);
  chain['transaction'] = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(chain));
  return { dbMock: chain, state: s };
});
vi.mock('../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../db/schema.js', () => ({
  orders: { id: 'id', state: 'state', __name: 'orders' },
  creditTransactions: { __name: 'creditTransactions' },
  userCredits: { __name: 'userCredits' },
  users: { id: 'id', __name: 'users' },
  pendingPayouts: { orderId: 'order_id', __name: 'pendingPayouts' },
  HOME_CURRENCIES: ['USD', 'GBP', 'EUR'] as const,
}));
vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('../../discord.js', () => ({
  notifyPegBreakOnFulfillment: vi.fn(),
}));
vi.mock('../../credits/payout-builder.js', () => ({
  buildPayoutIntent: () => ({ kind: 'skip', reason: 'no_cashback' }),
}));

import { markOrderFulfilled } from '../fulfillment.js';
import {
  decryptRedeemField,
  isEncryptedRedeemField,
  resetRedeemKeyCache,
  REDEEM_ENVELOPE_PREFIX,
} from '../redeem-crypto.js';

beforeEach(() => {
  state.updateSet = undefined;
  envState.LOOP_REDEEM_ENCRYPTION_KEY = KEY_B64;
  resetRedeemKeyCache();
});

describe('markOrderFulfilled — redeem secrets encrypted at rest', () => {
  it('persists code + PIN as ciphertext but leaves the URL plaintext', async () => {
    await markOrderFulfilled('o-1', {
      ctxOrderId: 'ctx-abc',
      redemption: {
        code: 'PLAINTEXT-GIFT-CODE',
        pin: '4242',
        url: 'https://merchant.example/redeem/abc',
      },
    });

    const set = state.updateSet!;
    const storedCode = set['redeemCode'] as string;
    const storedPin = set['redeemPin'] as string;
    const storedUrl = set['redeemUrl'] as string | null;

    // On disk: code + PIN are enveloped ciphertext, not the plaintext.
    expect(isEncryptedRedeemField(storedCode)).toBe(true);
    expect(storedCode.startsWith(REDEEM_ENVELOPE_PREFIX)).toBe(true);
    expect(storedCode).not.toContain('PLAINTEXT-GIFT-CODE');
    expect(isEncryptedRedeemField(storedPin)).toBe(true);
    expect(storedPin).not.toContain('4242');

    // URL stays plaintext (it's the landing page, not the secret).
    expect(storedUrl).toBe('https://merchant.example/redeem/abc');

    // The read path recovers the originals.
    expect(decryptRedeemField(storedCode)).toBe('PLAINTEXT-GIFT-CODE');
    expect(decryptRedeemField(storedPin)).toBe('4242');
  });

  it('persists NULLs unchanged when there is no redemption payload', async () => {
    await markOrderFulfilled('o-1', { ctxOrderId: 'ctx-abc' });
    const set = state.updateSet!;
    expect(set['redeemCode']).toBeNull();
    expect(set['redeemPin']).toBeNull();
    expect(set['redeemUrl']).toBeNull();
  });

  it('with the key unset, stores plaintext (ships dark — backward compatible)', async () => {
    envState.LOOP_REDEEM_ENCRYPTION_KEY = undefined;
    resetRedeemKeyCache();
    await markOrderFulfilled('o-1', {
      ctxOrderId: 'ctx-abc',
      redemption: { code: 'DARK-MODE-CODE', pin: '9999', url: null },
    });
    const set = state.updateSet!;
    expect(set['redeemCode']).toBe('DARK-MODE-CODE');
    expect(set['redeemPin']).toBe('9999');
    expect(isEncryptedRedeemField(set['redeemCode'] as string)).toBe(false);
  });
});
