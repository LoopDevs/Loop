import { describe, it, expect, beforeEach } from 'vitest';
import { usePurchaseStore } from '../purchase.store';

describe('purchase store', () => {
  beforeEach(() => {
    usePurchaseStore.getState().reset();
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
    });
    const state = usePurchaseStore.getState();
    expect(state.step).toBe('payment');
    expect(state.orderId).toBe('o-1');
    expect(state.paymentAddress).toBe('GXXX');
    expect(state.xlmAmount).toBe('10.5');
    expect(state.expiresAt).toBe(1234567890);
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
});
