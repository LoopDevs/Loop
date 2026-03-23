import { create } from 'zustand';

export type PurchaseStep = 'amount' | 'payment' | 'processing' | 'complete' | 'redeem' | 'error';

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
  /** Unix timestamp (seconds) — payment window closes after this. */
  expiresAt: number | null;
  giftCardCode: string | null;
  giftCardPin: string | null;
  redeemUrl: string | null;
  redeemChallengeCode: string | null;
  redeemScripts: { injectChallenge?: string; scrapeResult?: string } | null;
  error: string | null;
}

interface PurchaseActions {
  startPurchase: (merchantId: string, merchantName: string) => void;
  setAmount: (amount: number) => void;
  setOrderCreated: (params: {
    orderId: string;
    paymentAddress: string;
    xlmAmount: string;
    expiresAt: number;
  }) => void;
  setComplete: (giftCardCode: string, giftCardPin?: string) => void;
  setRedeemRequired: (params: {
    redeemUrl: string;
    redeemChallengeCode: string;
    redeemScripts?: { injectChallenge?: string; scrapeResult?: string };
  }) => void;
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
  expiresAt: null,
  giftCardCode: null,
  giftCardPin: null,
  redeemUrl: null,
  redeemChallengeCode: null,
  redeemScripts: null,
  error: null,
};

export const usePurchaseStore = create<PurchaseState & PurchaseActions>((set) => ({
  ...INITIAL_STATE,

  startPurchase: (merchantId, merchantName) => set({ ...INITIAL_STATE, merchantId, merchantName }),

  setAmount: (amount) => set({ amount }),

  setOrderCreated: ({ orderId, paymentAddress, xlmAmount, expiresAt }) =>
    set({ step: 'payment', orderId, paymentAddress, xlmAmount, expiresAt }),

  setComplete: (giftCardCode, giftCardPin) =>
    set({ step: 'complete', giftCardCode, giftCardPin: giftCardPin ?? null }),

  setRedeemRequired: ({ redeemUrl, redeemChallengeCode, redeemScripts }) =>
    set({ step: 'redeem', redeemUrl, redeemChallengeCode, redeemScripts: redeemScripts ?? null }),

  setError: (message) => set({ step: 'error', error: message }),

  reset: () => set(INITIAL_STATE),
}));
