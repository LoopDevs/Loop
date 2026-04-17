import { create } from 'zustand';
import {
  PENDING_ORDER_KEY,
  savePendingOrder,
  clearPendingOrder as clearPending,
} from '~/native/purchase-storage';

// 'processing' is intentionally absent — no action transitions to it. If a
// future flow needs an intermediate pre-complete state, add it here and
// wire up the corresponding setter + UI branch in PurchaseContainer.
export type PurchaseStep = 'amount' | 'payment' | 'complete' | 'redeem' | 'error';

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
 *
 * Validates the shape and step of the persisted record before adopting any
 * of it — otherwise a corrupted (or attacker-set) sessionStorage value
 * could drop the store directly into `step: 'complete'` with a fake gift
 * card code. We only ever *persist* the 'payment' step, so we only ever
 * *restore* the 'payment' step; anything else is evidence of tampering or
 * a bug and is discarded.
 */
function loadPendingOrderSync(): Partial<PurchaseState> | null {
  try {
    const raw = sessionStorage.getItem(PENDING_ORDER_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    const clean = validatePersistedPurchase(parsed);
    if (clean !== null) return clean;
    sessionStorage.removeItem(PENDING_ORDER_KEY);
  } catch {
    /* sessionStorage unavailable (native or SSR) or invalid JSON */
  }
  return null;
}

/**
 * Type-check the persisted record and return a whitelist-only subset.
 * Returns null if the record is malformed, expired, or not a payment-step
 * snapshot. Deliberately ignores unknown keys so an attacker can't inject
 * arbitrary state into the store.
 */
function validatePersistedPurchase(data: unknown): Partial<PurchaseState> | null {
  if (data === null || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.step !== 'payment') return null;
  if (typeof d.expiresAt !== 'number' || d.expiresAt <= Math.floor(Date.now() / 1000)) return null;
  const isStr = (v: unknown): v is string => typeof v === 'string';
  const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!isStr(d.orderId)) return null;
  if (!isStr(d.paymentAddress)) return null;
  if (!isStr(d.xlmAmount)) return null;
  if (!isStr(d.memo)) return null;
  return {
    step: 'payment',
    orderId: d.orderId,
    paymentAddress: d.paymentAddress,
    xlmAmount: d.xlmAmount,
    expiresAt: d.expiresAt,
    memo: d.memo,
    merchantId: isStr(d.merchantId) ? d.merchantId : null,
    merchantName: isStr(d.merchantName) ? d.merchantName : null,
    amount: isNum(d.amount) ? d.amount : null,
  };
}

/**
 * Serializes persistence ops (save, clear) through a single promise chain so
 * a save/clear pair initiated in quick succession always lands in the order
 * the actions were called. Without this, Capacitor Preferences on native
 * can race: a `clearPending` issued right after `savePendingOrder` may
 * resolve first, leaving stale state behind.
 */
let persistQueue: Promise<unknown> = Promise.resolve();
function enqueuePersist(op: () => Promise<void>): void {
  persistQueue = persistQueue.catch(() => {}).then(op);
  void persistQueue;
}

const restored = loadPendingOrderSync();

export const usePurchaseStore = create<PurchaseState & PurchaseActions>((set, get) => ({
  ...INITIAL_STATE,
  ...(restored ?? {}),

  startPurchase: (merchantId, merchantName) => set({ ...INITIAL_STATE, merchantId, merchantName }),

  setAmount: (amount) => set({ amount }),

  setOrderCreated: ({ orderId, paymentAddress, xlmAmount, expiresAt, memo }) => {
    set({ step: 'payment', orderId, paymentAddress, xlmAmount, expiresAt, memo });
    // Persist so app kill doesn't lose payment state. Queued so a subsequent
    // clear (in setComplete etc.) can't race this and leave stale state.
    const snapshot = get();
    enqueuePersist(() =>
      savePendingOrder({
        step: 'payment',
        orderId,
        paymentAddress,
        xlmAmount,
        expiresAt,
        memo,
        merchantId: snapshot.merchantId,
        merchantName: snapshot.merchantName,
        amount: snapshot.amount,
      }),
    );
  },

  setComplete: (giftCardCode, giftCardPin) => {
    enqueuePersist(() => clearPending());
    set({ step: 'complete', giftCardCode, giftCardPin: giftCardPin ?? null });
  },

  setRedeemRequired: ({ redeemUrl, redeemChallengeCode, redeemScripts }) => {
    enqueuePersist(() => clearPending());
    set({ step: 'redeem', redeemUrl, redeemChallengeCode, redeemScripts: redeemScripts ?? null });
  },

  setError: (message) => {
    enqueuePersist(() => clearPending());
    set({ step: 'error', error: message });
  },

  reset: () => {
    enqueuePersist(() => clearPending());
    set(INITIAL_STATE);
  },
}));
