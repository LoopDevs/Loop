import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSave = vi.fn<(data: Record<string, unknown>) => Promise<void>>();
const mockClear = vi.fn<() => Promise<void>>();
vi.mock('~/native/purchase-storage', () => ({
  PENDING_ORDER_KEY: 'loop_pending_order',
  savePendingOrder: (data: Record<string, unknown>) => mockSave(data),
  clearPendingOrder: () => mockClear(),
}));

import { usePurchaseStore } from '../purchase.store';

describe('purchase store', () => {
  beforeEach(async () => {
    mockSave.mockResolvedValue(undefined);
    mockClear.mockResolvedValue(undefined);
    usePurchaseStore.getState().reset();
    // The reset above enqueues a clearPending on the persistence queue.
    // Flush microtasks so it lands before we zero the mocks, otherwise
    // invocationCallOrder leaks across tests and the ordering assertions
    // read stale call records.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    mockSave.mockClear();
    mockClear.mockClear();
  });

  it('initializes with amount step', () => {
    const state = usePurchaseStore.getState();
    expect(state.step).toBe('amount');
    expect(state.merchantId).toBeNull();
  });

  it('startPurchase sets merchant info and resets state', () => {
    usePurchaseStore.getState().startPurchase('m-1', 'Target');
    const state = usePurchaseStore.getState();
    expect(state.merchantId).toBe('m-1');
    expect(state.merchantName).toBe('Target');
    expect(state.step).toBe('amount');
  });

  it('setAmount stores the amount', () => {
    usePurchaseStore.getState().setAmount(25);
    expect(usePurchaseStore.getState().amount).toBe(25);
  });

  it('setOrderCreated transitions to payment step', () => {
    usePurchaseStore.getState().setOrderCreated({
      orderId: 'o-1',
      paymentAddress: 'GXXX',
      xlmAmount: '10.5',
      expiresAt: 1234567890,
      memo: 'ctx:testmemo123',
    });
    const state = usePurchaseStore.getState();
    expect(state.step).toBe('payment');
    expect(state.orderId).toBe('o-1');
    expect(state.paymentAddress).toBe('GXXX');
    expect(state.xlmAmount).toBe('10.5');
    expect(state.expiresAt).toBe(1234567890);
    expect(state.memo).toBe('ctx:testmemo123');
  });

  it('setComplete transitions to complete step with code and pin', () => {
    usePurchaseStore.getState().setComplete('GIFTCODE123', 'PIN456');
    const state = usePurchaseStore.getState();
    expect(state.step).toBe('complete');
    expect(state.giftCardCode).toBe('GIFTCODE123');
    expect(state.giftCardPin).toBe('PIN456');
  });

  it('setComplete handles missing pin', () => {
    usePurchaseStore.getState().setComplete('GIFTCODE123');
    const state = usePurchaseStore.getState();
    expect(state.giftCardCode).toBe('GIFTCODE123');
    expect(state.giftCardPin).toBeNull();
  });

  it('setRedeemRequired transitions to redeem step', () => {
    usePurchaseStore.getState().setRedeemRequired({
      redeemUrl: 'https://provider.com/redeem',
      redeemChallengeCode: 'ABC123',
      redeemScripts: {
        injectChallenge: 'document.querySelector("input").value = "ABC123"',
        scrapeResult: '(function(){ window.postMessage({type:"loop:giftcard",code:"X"}, "*") })()',
      },
    });
    const state = usePurchaseStore.getState();
    expect(state.step).toBe('redeem');
    expect(state.redeemUrl).toBe('https://provider.com/redeem');
    expect(state.redeemChallengeCode).toBe('ABC123');
    expect(state.redeemScripts?.injectChallenge).toContain('ABC123');
    expect(state.redeemScripts?.scrapeResult).toContain('loop:giftcard');
  });

  it('setRedeemRequired works without scripts', () => {
    usePurchaseStore.getState().setRedeemRequired({
      redeemUrl: 'https://provider.com/redeem',
      redeemChallengeCode: 'XYZ',
    });
    const state = usePurchaseStore.getState();
    expect(state.step).toBe('redeem');
    expect(state.redeemScripts).toBeNull();
  });

  it('setError transitions to error step', () => {
    usePurchaseStore.getState().setError('Something failed');
    const state = usePurchaseStore.getState();
    expect(state.step).toBe('error');
    expect(state.error).toBe('Something failed');
  });

  it('reset returns to initial state', () => {
    usePurchaseStore.getState().setComplete('CODE', 'PIN');
    usePurchaseStore.getState().reset();
    const state = usePurchaseStore.getState();
    expect(state.step).toBe('amount');
    expect(state.giftCardCode).toBeNull();
    expect(state.redeemUrl).toBeNull();
  });

  describe('persistence side effects', () => {
    // `enqueuePersist` schedules on a promise chain; flush microtasks so
    // tests can observe the mocked save/clear calls.
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };

    it('setOrderCreated persists the payment snapshot', async () => {
      usePurchaseStore.getState().startPurchase('m-1', 'Target');
      usePurchaseStore.getState().setAmount(25);
      usePurchaseStore.getState().setOrderCreated({
        orderId: 'o-1',
        paymentAddress: 'GXXX',
        xlmAmount: '10.5',
        expiresAt: Math.floor(Date.now() / 1000) + 600,
        memo: 'ctx:memo',
      });
      await flush();
      expect(mockSave).toHaveBeenCalledTimes(1);
      const payload = mockSave.mock.calls[0]![0];
      expect(payload).toMatchObject({
        step: 'payment',
        orderId: 'o-1',
        merchantId: 'm-1',
        merchantName: 'Target',
        amount: 25,
      });
    });

    it('setComplete clears persisted state', async () => {
      usePurchaseStore.getState().setComplete('CODE');
      await flush();
      expect(mockClear).toHaveBeenCalled();
    });

    it('setRedeemRequired clears persisted state', async () => {
      usePurchaseStore.getState().setRedeemRequired({
        redeemUrl: 'https://x',
        redeemChallengeCode: 'C',
      });
      await flush();
      expect(mockClear).toHaveBeenCalled();
    });

    it('setError clears persisted state', async () => {
      usePurchaseStore.getState().setError('oops');
      await flush();
      expect(mockClear).toHaveBeenCalled();
    });

    it('save-then-complete sequences save before clear (no race)', async () => {
      usePurchaseStore.getState().startPurchase('m-1', 'Target');
      usePurchaseStore.getState().setOrderCreated({
        orderId: 'o-1',
        paymentAddress: 'GXXX',
        xlmAmount: '10.5',
        expiresAt: Math.floor(Date.now() / 1000) + 600,
        memo: 'ctx:memo',
      });
      usePurchaseStore.getState().setComplete('CODE');
      await flush();
      // Both ran, and save ran before clear — vitest records each call with
      // an `invocationCallOrder`, so comparing gives strict ordering.
      expect(mockSave).toHaveBeenCalled();
      expect(mockClear).toHaveBeenCalled();
      const saveOrder = mockSave.mock.invocationCallOrder[0]!;
      const clearOrder = mockClear.mock.invocationCallOrder[0]!;
      expect(saveOrder).toBeLessThan(clearOrder);
    });
  });
});
