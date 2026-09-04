import { create } from 'zustand';

/**
 * Purchase-flow scoping store (ADR 052).
 *
 * ADR 052 shrank this store to merchant scoping only: the ctx-payment
 * flow keeps its order state in `PurchaseContainer` local state (the
 * `CreateLoopOrderResponse`), rebuilt server-side on remount via
 * `~/hooks/use-loop-order-restore.ts` — nothing payment-directing is
 * ever persisted client-side. The legacy CTX-proxy fields
 * (paymentAddress / xlmAmount / memo / expiresAt / redeem payload)
 * left with `POST /api/orders`.
 *
 * `merchantId` is the cross-component guard: `PurchaseContainer` only
 * renders in-flight purchase UI when the store's merchant matches the
 * merchant page being viewed, so opening merchant B mid-purchase at
 * merchant A never shows A's payment card on B's page.
 */
interface PurchaseState {
  merchantId: string | null;
  merchantName: string | null;
}

interface PurchaseActions {
  startPurchase: (merchantId: string, merchantName: string) => void;
  reset: () => void;
}

const INITIAL_STATE: PurchaseState = {
  merchantId: null,
  merchantName: null,
};

export const usePurchaseStore = create<PurchaseState & PurchaseActions>((set) => ({
  ...INITIAL_STATE,

  startPurchase: (merchantId, merchantName) => set({ merchantId, merchantName }),

  reset: () => set(INITIAL_STATE),
}));
