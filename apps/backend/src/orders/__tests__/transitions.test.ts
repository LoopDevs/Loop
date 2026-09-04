/**
 * Mirror-transition writer tests (ADR 052). The writers are guarded
 * single-row UPDATEs; these tests pin the SET payloads (including the
 * at-rest encryption of redemption secrets) through a captured db
 * chain. The state guards themselves are SQL (`WHERE state IN ...`)
 * — the update-vs-null return contract is pinned by returning-row
 * control; guard membership is covered by the integration suite.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock, state, envState } = vi.hoisted(() => {
  const s = {
    updateSet: undefined as Record<string, unknown> | undefined,
    returningRows: [] as unknown[],
  };
  const envState = { redeemKey: undefined as string | undefined };
  const chain: Record<string, unknown> = {};
  chain['update'] = vi.fn(() => chain);
  chain['set'] = vi.fn((v: Record<string, unknown>) => {
    s.updateSet = v;
    return chain;
  });
  chain['where'] = vi.fn(() => chain);
  chain['returning'] = vi.fn(async () => s.returningRows);
  return { dbMock: chain, state: s, envState };
});

vi.mock('../../env.js', () => ({
  get env() {
    return { LOOP_REDEEM_ENCRYPTION_KEY: envState.redeemKey };
  },
}));

vi.mock('../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../db/schema.js', () => ({
  orders: {
    id: 'id',
    state: 'state',
    failedAt: 'failed_at',
    failureReason: 'failure_reason',
    fulfilledAt: 'fulfilled_at',
    redeemCode: 'redeem_code',
    redeemPin: 'redeem_pin',
    redeemUrl: 'redeem_url',
  },
}));

import { resetRedeemKeyCache } from '../redeem-crypto.js';
import {
  markOrderExpired,
  markOrderFulfilled,
  markOrderPaid,
  markOrderRefunded,
  markOrderRejected,
} from '../transitions.js';

beforeEach(() => {
  state.updateSet = undefined;
  state.returningRows = [];
  envState.redeemKey = undefined;
  resetRedeemKeyCache();
});

describe('markOrderPaid', () => {
  it('sets state=paid and returns the row', async () => {
    state.returningRows = [{ id: 'o-1', state: 'paid' }];
    const r = await markOrderPaid('o-1');
    expect(r?.state).toBe('paid');
    expect(state.updateSet).toEqual({ state: 'paid' });
  });

  it('returns null when the guard does not match (already past unpaid)', async () => {
    state.returningRows = [];
    expect(await markOrderPaid('o-1')).toBeNull();
  });
});

describe('markOrderFulfilled', () => {
  it('sets state, fulfilledAt, and the redemption payload', async () => {
    state.returningRows = [{ id: 'o-1', state: 'fulfilled' }];
    const r = await markOrderFulfilled('o-1', {
      redemption: { code: 'CODE-1', pin: '1234', url: 'https://redeem.example/x' },
    });
    expect(r?.state).toBe('fulfilled');
    expect(state.updateSet).toMatchObject({
      state: 'fulfilled',
      fulfilledAt: expect.any(Date),
      redeemUrl: 'https://redeem.example/x',
    });
    // No encryption key in this test env → plaintext passthrough.
    expect(state.updateSet?.['redeemCode']).toBe('CODE-1');
    expect(state.updateSet?.['redeemPin']).toBe('1234');
  });

  it('CF-25: encrypts code + pin at rest when the key is set, url stays plaintext', async () => {
    envState.redeemKey = Buffer.alloc(32, 7).toString('base64');
    state.returningRows = [{ id: 'o-1', state: 'fulfilled' }];
    await markOrderFulfilled('o-1', {
      redemption: { code: 'SECRET-CODE', pin: '9999', url: 'https://redeem.example/y' },
    });
    expect(String(state.updateSet?.['redeemCode'])).toMatch(/^enc:v1:/);
    expect(String(state.updateSet?.['redeemPin'])).toMatch(/^enc:v1:/);
    expect(state.updateSet?.['redeemUrl']).toBe('https://redeem.example/y');
  });

  it('fulfils with null payload when the redemption fetch raced (backfill retries)', async () => {
    state.returningRows = [{ id: 'o-1', state: 'fulfilled' }];
    await markOrderFulfilled('o-1', {});
    expect(state.updateSet?.['redeemCode']).toBeNull();
    expect(state.updateSet?.['redeemPin']).toBeNull();
    expect(state.updateSet?.['redeemUrl']).toBeNull();
  });
});

describe('markOrderRejected', () => {
  it('sets state, failedAt, and the reason', async () => {
    state.returningRows = [{ id: 'o-1', state: 'rejected' }];
    await markOrderRejected('o-1', 'rejected by supplier');
    expect(state.updateSet).toMatchObject({
      state: 'rejected',
      failedAt: expect.any(Date),
      failureReason: 'rejected by supplier',
    });
  });

  it('omits failureReason when null (keeps any earlier reason)', async () => {
    state.returningRows = [{ id: 'o-1', state: 'rejected' }];
    await markOrderRejected('o-1', null);
    expect(state.updateSet).not.toHaveProperty('failureReason');
  });
});

describe('markOrderRefunded', () => {
  it('sets state + failedAt', async () => {
    state.returningRows = [{ id: 'o-1', state: 'refunded' }];
    await markOrderRefunded('o-1');
    expect(state.updateSet).toMatchObject({ state: 'refunded', failedAt: expect.any(Date) });
  });
});

describe('markOrderExpired', () => {
  it('sets state=expired with the payment-window reason', async () => {
    state.returningRows = [{ id: 'o-1', state: 'expired' }];
    await markOrderExpired('o-1');
    expect(state.updateSet).toMatchObject({
      state: 'expired',
      failureReason: 'payment window expired',
    });
  });

  it('returns null when the row already left unpaid (paid event won)', async () => {
    state.returningRows = [];
    expect(await markOrderExpired('o-1')).toBeNull();
  });
});
