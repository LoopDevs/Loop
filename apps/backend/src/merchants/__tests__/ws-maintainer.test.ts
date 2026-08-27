import { describe, it, expect, vi, beforeEach } from 'vitest';

// Env mock mirrors sync.test.ts's pattern: mutable so scenarios can flip
// INCLUDE_DISABLED_MERCHANTS without resetting modules.
const { envState } = vi.hoisted(() => ({
  envState: {
    GIFT_CARD_API_BASE_URL: 'http://test',
    GIFT_CARD_API_KEY: 'test-key',
    GIFT_CARD_API_SECRET: 'test-secret',
    INCLUDE_DISABLED_MERCHANTS: false,
  },
}));
vi.mock('../../env.js', () => ({ env: envState }));

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
}));

// The maintainer's store side effects all go through sync.js — mock it
// whole so message handling is assertable without sockets or fetches.
const { syncMock } = vi.hoisted(() => ({
  syncMock: {
    applyMerchantUpsert: vi.fn(),
    applyMerchantRemoval: vi.fn(),
    isMerchantDenylisted: vi.fn(() => false),
    refreshMerchants: vi.fn(async () => {}),
  },
}));
vi.mock('../sync.js', () => syncMock);

import { __handleWsMessageForTests, __resetMerchantWsForTests } from '../ws-maintainer.js';

function eventFrame(eventName: string, data: unknown): string {
  return JSON.stringify({ type: 'event', topic: 'merchant', event: eventName, data });
}

const SUBSCRIBE_OK = JSON.stringify({
  type: 'ok',
  action: 'subscribe',
  subscriptions: ['merchant'],
});

const MERCHANT = {
  id: 'm-1',
  name: 'Airbnb Canada',
  enabled: true,
  updated: '2026-08-26T10:00:00Z',
  logoUrl: 'https://img.test/airbnb.png',
  savingsPercentage: 400,
  currency: 'CAD',
  country: 'CA',
};

describe('merchant ws maintainer message handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncMock.isMerchantDenylisted.mockReturnValue(false);
    envState.INCLUDE_DISABLED_MERCHANTS = false;
    __resetMerchantWsForTests();
  });

  it('upserts a mapped merchant on system.merchant.updated', () => {
    __handleWsMessageForTests(eventFrame('system.merchant.updated', MERCHANT));

    expect(syncMock.applyMerchantUpsert).toHaveBeenCalledTimes(1);
    const merchant = syncMock.applyMerchantUpsert.mock.calls[0]![0] as Record<string, unknown>;
    expect(merchant['id']).toBe('m-1');
    expect(merchant['name']).toBe('Airbnb Canada');
    expect(merchant['updatedAt']).toBe('2026-08-26T10:00:00Z');
    // savingsPercentage runs through the same /100 conversion as the sweep
    expect(merchant['savingsPercentage']).toBe(4.0);
    expect(syncMock.applyMerchantRemoval).not.toHaveBeenCalled();
  });

  it('upserts on system.merchant.created and system.merchant.status_changed', () => {
    __handleWsMessageForTests(eventFrame('system.merchant.created', MERCHANT));
    __handleWsMessageForTests(eventFrame('system.merchant.status_changed', MERCHANT));
    expect(syncMock.applyMerchantUpsert).toHaveBeenCalledTimes(2);
  });

  it('removes the merchant on system.merchant.deleted', () => {
    __handleWsMessageForTests(eventFrame('system.merchant.deleted', MERCHANT));
    expect(syncMock.applyMerchantRemoval).toHaveBeenCalledWith('m-1');
    expect(syncMock.applyMerchantUpsert).not.toHaveBeenCalled();
  });

  it('removes a merchant that becomes disabled (mapper returns null)', () => {
    __handleWsMessageForTests(
      eventFrame('system.merchant.updated', { ...MERCHANT, enabled: false }),
    );
    expect(syncMock.applyMerchantRemoval).toHaveBeenCalledWith('m-1');
    expect(syncMock.applyMerchantUpsert).not.toHaveBeenCalled();
  });

  it('respects LOOP_MERCHANT_DENYLIST on event-driven upserts', () => {
    syncMock.isMerchantDenylisted.mockReturnValue(true);
    __handleWsMessageForTests(eventFrame('system.merchant.updated', MERCHANT));
    expect(syncMock.applyMerchantUpsert).not.toHaveBeenCalled();
    expect(syncMock.applyMerchantRemoval).not.toHaveBeenCalled();
  });

  it('ignores unknown event names, malformed payloads, and non-JSON frames', () => {
    __handleWsMessageForTests(eventFrame('system.giftcard.updated', MERCHANT));
    __handleWsMessageForTests(eventFrame('system.merchant.updated', { nope: true }));
    __handleWsMessageForTests('not json at all');
    __handleWsMessageForTests(JSON.stringify({ type: 'weird' }));
    expect(syncMock.applyMerchantUpsert).not.toHaveBeenCalled();
    expect(syncMock.applyMerchantRemoval).not.toHaveBeenCalled();
  });

  it('resyncs the full catalog on reconnect, but not on the first session', () => {
    // First subscribe-ok: fresh boot, the startup sweep already ran.
    __handleWsMessageForTests(SUBSCRIBE_OK);
    expect(syncMock.refreshMerchants).not.toHaveBeenCalled();

    // Second subscribe-ok: a reconnect — events may have been missed.
    __handleWsMessageForTests(SUBSCRIBE_OK);
    expect(syncMock.refreshMerchants).toHaveBeenCalledTimes(1);
  });
});
