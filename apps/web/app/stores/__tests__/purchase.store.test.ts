import { describe, it, expect, beforeEach } from 'vitest';

import { usePurchaseStore } from '../purchase.store';

describe('purchase store', () => {
  beforeEach(() => {
    usePurchaseStore.getState().reset();
  });

  it('initializes with no merchant', () => {
    const state = usePurchaseStore.getState();
    expect(state.merchantId).toBeNull();
    expect(state.merchantName).toBeNull();
  });

  it('startPurchase sets merchant info', () => {
    usePurchaseStore.getState().startPurchase('m-1', 'Target');
    const state = usePurchaseStore.getState();
    expect(state.merchantId).toBe('m-1');
    expect(state.merchantName).toBe('Target');
  });

  it('startPurchase replaces a previous merchant', () => {
    usePurchaseStore.getState().startPurchase('m-1', 'Target');
    usePurchaseStore.getState().startPurchase('m-2', 'Amazon');
    const state = usePurchaseStore.getState();
    expect(state.merchantId).toBe('m-2');
    expect(state.merchantName).toBe('Amazon');
  });

  it('reset returns to initial state', () => {
    usePurchaseStore.getState().startPurchase('m-1', 'Target');
    usePurchaseStore.getState().reset();
    const state = usePurchaseStore.getState();
    expect(state.merchantId).toBeNull();
    expect(state.merchantName).toBeNull();
  });
});
