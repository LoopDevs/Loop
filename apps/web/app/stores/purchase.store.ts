import { create } from 'zustand';
import {
  PENDING_ORDER_KEY,
  savePendingOrder,
  clearPendingOrder as clearPending,
} from '~/native/purchase-storage';

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
  /** Payment memo (required for Stellar payment identification). */
  memo: string | null;
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
    memo: string;
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
  memo: null,
  giftCardCode: null,
  giftCardPin: null,
  redeemUrl: null,
  redeemChallengeCode: null,
  redeemScripts: null,
  error: null,
};

/**
 * Synchronous sessionStorage restore for initial web state.
 * On native, async restoration happens via useSessionRestore.
 */
function loadPendingOrderSync(): Partial<PurchaseState> | null {
  try {
    const raw = sessionStorage.getItem(PENDING_ORDER_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<PurchaseState>;
    if (data.expiresAt && data.expiresAt > Math.floor(Date.now() / 1000)) {
      return data;
    }
    sessionStorage.removeItem(PENDING_ORDER_KEY);
  } catch {
    /* sessionStorage unavailable (native or SSR) */
  }
  return null;
}

const restored = loadPendingOrderSync();

export const usePurchaseStore = create<PurchaseState & PurchaseActions>((set, get) => ({
  ...INITIAL_STATE,
  ...(restored ?? {}),

  startPurchase: (merchantId, merchantName) => set({ ...INITIAL_STATE, merchantId, merchantName }),

  setAmount: (amount) => set({ amount }),

  setOrderCreated: ({ orderId, paymentAddress, xlmAmount, expiresAt, memo }) => {
    set({ step: 'payment', orderId, paymentAddress, xlmAmount, expiresAt, memo });
    // Persist so app kill doesn't lose payment state
    void savePendingOrder({
      step: 'payment',
      orderId,
      paymentAddress,
      xlmAmount,
      expiresAt,
      memo,
      merchantId: get().merchantId,
      merchantName: get().merchantName,
      amount: get().amount,
    });
  },

  setComplete: (giftCardCode, giftCardPin) => {
    void clearPending();
    set({ step: 'complete', giftCardCode, giftCardPin: giftCardPin ?? null });
  },

  setRedeemRequired: ({ redeemUrl, redeemChallengeCode, redeemScripts }) => {
    void clearPending();
    set({ step: 'redeem', redeemUrl, redeemChallengeCode, redeemScripts: redeemScripts ?? null });
  },

  setError: (message) => {
    void clearPending();
    set({ step: 'error', error: message });
  },

  reset: () => {
    void clearPending();
    set(INITIAL_STATE);
  },
}));
