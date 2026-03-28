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

const STORAGE_KEY = 'loop_pending_order';

function loadPendingOrder(): Partial<PurchaseState> | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<PurchaseState>;
    // Only restore if not expired
    if (data.expiresAt && data.expiresAt > Math.floor(Date.now() / 1000)) {
      return data;
    }
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* sessionStorage unavailable */
  }
  return null;
}

function clearPendingOrder(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* sessionStorage unavailable */
  }
}

const restored = loadPendingOrder();

export const usePurchaseStore = create<PurchaseState & PurchaseActions>((set, get) => ({
  ...INITIAL_STATE,
  ...(restored ?? {}),

  startPurchase: (merchantId, merchantName) => set({ ...INITIAL_STATE, merchantId, merchantName }),

  setAmount: (amount) => set({ amount }),

  setOrderCreated: ({ orderId, paymentAddress, xlmAmount, expiresAt, memo }) => {
    set({ step: 'payment', orderId, paymentAddress, xlmAmount, expiresAt, memo });
    // Persist so app kill doesn't lose payment state
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          step: 'payment',
          orderId,
          paymentAddress,
          xlmAmount,
          expiresAt,
          memo,
          merchantId: get().merchantId,
          merchantName: get().merchantName,
          amount: get().amount,
        }),
      );
    } catch {
      /* sessionStorage unavailable */
    }
  },

  setComplete: (giftCardCode, giftCardPin) => {
    clearPendingOrder();
    set({ step: 'complete', giftCardCode, giftCardPin: giftCardPin ?? null });
  },

  setRedeemRequired: ({ redeemUrl, redeemChallengeCode, redeemScripts }) => {
    clearPendingOrder();
    set({ step: 'redeem', redeemUrl, redeemChallengeCode, redeemScripts: redeemScripts ?? null });
  },

  setError: (message) => {
    clearPendingOrder();
    set({ step: 'error', error: message });
  },

  reset: () => {
    clearPendingOrder();
    set(INITIAL_STATE);
  },
}));
