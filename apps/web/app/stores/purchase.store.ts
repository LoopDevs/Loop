import { create } from 'zustand';

export type PurchaseStep = 'amount' | 'payment' | 'processing' | 'complete' | 'error';

interface PurchaseState {
  step: PurchaseStep;
  merchantId: string | null;
  merchantName: string | null;
  amount: number | null;
  /** XLM payment address returned when an order is created. */
  paymentAddress: string | null;
  /** XLM amount to send. */
  xlmAmount: string | null;
  orderId: string | null;
  giftCardCode: string | null;
  giftCardPin: string | null;
  error: string | null;
}

interface PurchaseActions {
  startPurchase: (merchantId: string, merchantName: string) => void;
  setAmount: (amount: number) => void;
  setOrderCreated: (params: {
    orderId: string;
    paymentAddress: string;
    xlmAmount: string;
  }) => void;
  setComplete: (giftCardCode: string, giftCardPin?: string) => void;
  setError: (message: string) => void;
  reset: () => void;
}

const INITIAL_STATE: PurchaseState = {
  step: 'amount',
  merchantId: null,
  merchantName: null,
  amount: null,
  paymentAddress: null,
  xlmAmount: null,
  orderId: null,
  giftCardCode: null,
  giftCardPin: null,
  error: null,
};

export const usePurchaseStore = create<PurchaseState & PurchaseActions>((set) => ({
  ...INITIAL_STATE,

  startPurchase: (merchantId, merchantName) =>
    set({ ...INITIAL_STATE, merchantId, merchantName }),

  setAmount: (amount) => set({ amount }),

  setOrderCreated: ({ orderId, paymentAddress, xlmAmount }) =>
    set({ step: 'payment', orderId, paymentAddress, xlmAmount }),

  setComplete: (giftCardCode, giftCardPin) =>
    set({ step: 'complete', giftCardCode, giftCardPin: giftCardPin ?? null }),

  setError: (message) => set({ step: 'error', error: message }),

  reset: () => set(INITIAL_STATE),
}));
