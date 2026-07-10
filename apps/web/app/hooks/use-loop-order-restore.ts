import { useEffect, useState } from 'react';
import { ApiException } from '@loop/shared';
import {
  LOOP_NATIVE_PENDING_ORDER_KEY,
  savePendingOrder,
  loadPendingOrder,
  clearPendingOrder,
} from '~/native/purchase-storage';
import {
  getLoopOrder,
  isLoopOrderTerminal,
  type CreateLoopOrderResponse,
} from '~/services/orders-loop';

/**
 * Restore-on-remount for an in-progress loop-native order (ADR 010).
 *
 * Context: the loop-native payment screen renders from `loopCreate`,
 * component-local `useState` in `PurchaseContainer`. It is never
 * re-derived from the server, so ANY remount mid-payment — a re-render
 * that fires the container's `[merchant.id]` cleanup effect, a slow-
 * connection late fetch, a tab refresh — strands the user at the
 * amount-selection form even though a live, payable order exists
 * server-side (real order row, real deposit memo). This hook is what
 * lets `PurchaseContainer` re-hydrate `loopCreate` on the next mount
 * instead of silently losing it. Mirrors `useSessionRestore`'s
 * pending-purchase restore for the legacy CTX-proxy path.
 *
 * Why persist the full `create` response instead of re-deriving it from
 * `GET /api/orders/loop/:id`: `LoopPaymentStep` renders `assetAmount`,
 * `paymentUri` (the SEP-7 "Open in wallet" link), and — for `loop_asset`
 * — `assetCode`/`assetIssuer`. Those are quoted once at order-creation
 * time and are NOT part of `LoopOrderView` (the read-side shape) — they
 * can't be reconstructed from the GET response. So this hook persists
 * the original `POST /api/orders/loop` response (the exact object
 * `PurchaseContainer` already builds `<LoopPaymentStep create={...}>`
 * from) rather than trying to rebuild it from the read view.
 *
 * Money-safety: the GET call here is what makes restoring that persisted
 * object safe, not what supplies its payment fields. Before ever
 * re-rendering the payment screen from a persisted record, this hook:
 *   1. Fetches the order (owner-scoped — 404s for a non-owner or
 *      unknown id; a stale record from a previous account on the same
 *      device fails closed here, never leaking one user's order to
 *      another).
 *   2. Refuses to restore an already-terminal order (fulfilled / failed
 *      / expired) — those belong on the order-history view, not a
 *      resurrected purchase form — and clears the persisted record.
 *   3. Cross-checks the persisted deposit address + memo — AND the
 *      destination + memo embedded in the persisted `paymentUri`
 *      (the SEP-7 deep-link the "Open in wallet" button uses, which is
 *      the ONLY payment affordance shown on native — see
 *      `LoopPaymentStep.tsx`'s `NativePaymentBody`) — against what the
 *      server has on file for the order. `stellarAddress`/`memo` and
 *      `paymentUri` are separate fields in the persisted record; a
 *      tampered copy could otherwise pass the address/memo check while
 *      carrying a `paymentUri` that deep-links a wallet to a DIFFERENT,
 *      attacker-controlled destination. A mismatch on any of these
 *      (tampered or stale local copy) is treated as untrustworthy:
 *      cleared, never shown.
 * This hook only ever calls `GET /api/orders/loop/:id` — it never calls
 * `POST /api/orders/loop`, so a restore can never create a duplicate
 * order.
 */

interface UseLoopOrderRestoreArgs {
  /** The merchant currently being viewed — restore only applies to a
   *  persisted record scoped to this exact merchant. */
  merchantId: string;
  /** Gate the restore attempt (pass `isAuthenticated && loopOrdersEnabled`)
   *  so this never fires a doomed fetch while signed out or the
   *  loop-native path is off. */
  enabled: boolean;
}

export interface LoopOrderRestoreResult {
  create: CreateLoopOrderResponse;
}

/** Recovery window for a persisted-but-unconfirmed record. Generous
 *  enough to cover a slow crypto deposit + procurement; short enough
 *  that an order abandoned mid-flow doesn't resurrect indefinitely on
 *  an unrelated later visit. Refreshed (see `useLoopOrderRestore` below)
 *  on every successful restore, so a long-lived but still-live order
 *  surviving several remounts doesn't age out mid-payment. */
export const LOOP_PENDING_ORDER_TTL_SECONDS = 20 * 60;

interface PersistedLoopOrder {
  merchantId: string;
  orderId: string;
  create: CreateLoopOrderResponse;
}

/**
 * Persists the just-created order so a later remount can restore it.
 * Call this right after `setLoopCreate(result)` in `PurchaseContainer`.
 *
 * Sets `expiresAt` explicitly to `LOOP_PENDING_ORDER_TTL_SECONDS` out —
 * `savePendingOrder`'s generic storage layer (`purchase-storage.ts`)
 * defaults to its OWN 15-minute `DEFAULT_EXPIRY_SECONDS` for any record
 * that omits `expiresAt`, which would silently undercut this module's
 * documented 20-minute recovery window (the record would be
 * self-destroyed by the storage layer 5 minutes before
 * `validatePersistedLoopOrder`'s own TTL check would have expired it).
 */
export function saveLoopPendingOrder(record: PersistedLoopOrder): void {
  const now = Math.floor(Date.now() / 1000);
  enqueuePersist(() =>
    savePendingOrder(
      { ...record, savedAt: now, expiresAt: now + LOOP_PENDING_ORDER_TTL_SECONDS },
      LOOP_NATIVE_PENDING_ORDER_KEY,
    ),
  );
}

/** Clears the persisted record. Call on terminal state (fulfilled /
 *  failed / expired) and on a not-found/forbidden restore GET. */
export function clearLoopPendingOrder(): void {
  enqueuePersist(() => clearPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY));
}

// Serializes save/clear through one promise chain, same rationale as
// purchase.store.ts's `enqueuePersist` — a clear issued right after a
// save could otherwise resolve first on native Capacitor storage,
// leaving a stale record behind.
let persistQueue: Promise<unknown> = Promise.resolve();
function enqueuePersist(op: () => Promise<void>): void {
  persistQueue = persistQueue.catch(() => {}).then(op);
  void persistQueue;
}

const STELLAR_METHODS = ['xlm', 'usdc', 'loop_asset'] as const;

/**
 * Parses the `destination` + `memo` query params out of a SEP-7
 * `web+stellar:pay?...` URI. Returns null if the string doesn't parse
 * as a URL at all (defensively — a malformed persisted `paymentUri`
 * should fail the cross-check, not throw).
 */
function parseSep7DestinationAndMemo(
  paymentUri: string,
): { destination: string | null; memo: string | null } | null {
  try {
    const url = new URL(paymentUri);
    return { destination: url.searchParams.get('destination'), memo: url.searchParams.get('memo') };
  } catch {
    return null;
  }
}

function isValidPaymentShape(payment: unknown): payment is CreateLoopOrderResponse['payment'] {
  if (payment === null || typeof payment !== 'object') return false;
  const p = payment as Record<string, unknown>;
  const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  if (p.method === 'credit') {
    return isStr(p.amountMinor) && isStr(p.currency);
  }
  if (typeof p.method === 'string' && (STELLAR_METHODS as readonly string[]).includes(p.method)) {
    const base =
      isStr(p.stellarAddress) &&
      isStr(p.memo) &&
      isStr(p.amountMinor) &&
      isStr(p.currency) &&
      isStr(p.assetAmount) &&
      isStr(p.paymentUri);
    if (!base) return false;
    if (p.method === 'loop_asset') return isStr(p.assetCode) && isStr(p.assetIssuer);
    return true;
  }
  return false;
}

/**
 * Validates + whitelists a raw persisted record before it's trusted.
 * Returns null for anything malformed, expired, or scoped to a merchant
 * other than `expectedMerchantId` — mirrors `validatePersistedPurchase`
 * (purchase.store.ts)'s tamper-resistance posture: an attacker with
 * local-storage access (or a corrupted record) shouldn't be able to
 * inject arbitrary state by hand-editing it. Every field is type +
 * shape checked; `useLoopOrderRestore` additionally cross-checks the
 * deposit address + memo against the server before ever rendering
 * payment instructions built from this.
 */
export function validatePersistedLoopOrder(
  data: unknown,
  expectedMerchantId: string,
): PersistedLoopOrder | null {
  if (data === null || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.merchantId !== 'string' || d.merchantId !== expectedMerchantId) return null;
  if (typeof d.orderId !== 'string' || d.orderId.length === 0) return null;
  if (typeof d.savedAt !== 'number' || !Number.isFinite(d.savedAt)) return null;
  if (d.savedAt + LOOP_PENDING_ORDER_TTL_SECONDS <= Math.floor(Date.now() / 1000)) return null;
  if (d.create === null || typeof d.create !== 'object') return null;
  const create = d.create as Record<string, unknown>;
  if (create.orderId !== d.orderId) return null;
  if (!isValidPaymentShape(create.payment)) return null;
  return {
    merchantId: d.merchantId,
    orderId: d.orderId,
    create: d.create as unknown as CreateLoopOrderResponse,
  };
}

/**
 * Restore hook — see module doc above. Fires once per
 * `(merchantId, enabled)` pair; returns `{ create }` once a persisted
 * order has been validated as live + owned by the caller, or stays
 * `null` (the common case — no persisted order, or nothing left to
 * restore).
 */
export function useLoopOrderRestore({ merchantId, enabled }: UseLoopOrderRestoreArgs): {
  restored: LoopOrderRestoreResult | null;
} {
  const [restored, setRestored] = useState<LoopOrderRestoreResult | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    void (async (): Promise<void> => {
      try {
        const raw = await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY);
        const persisted = validatePersistedLoopOrder(raw, merchantId);
        if (persisted === null) return;

        const order = await getLoopOrder(persisted.orderId);
        if (cancelled) return;

        if (order.merchantId !== merchantId || isLoopOrderTerminal(order.state)) {
          clearLoopPendingOrder();
          return;
        }

        const payment = persisted.create.payment;
        if (payment.method !== order.paymentMethod) {
          clearLoopPendingOrder();
          return;
        }
        // Defense in depth: the deposit destination the server has on
        // file must match what we persisted at creation time. A
        // mismatch means the local copy is stale or tampered — never
        // show payment instructions we can't corroborate server-side.
        if (
          payment.method !== 'credit' &&
          (payment.stellarAddress !== order.stellarAddress || payment.memo !== order.paymentMemo)
        ) {
          clearLoopPendingOrder();
          return;
        }
        // Also cross-check the destination + memo EMBEDDED in the
        // persisted `paymentUri` — on native this SEP-7 deep-link is
        // the only payment affordance shown (no separate address/memo
        // text), so validating `stellarAddress`/`memo` alone isn't
        // enough: a tampered record could carry correct top-level
        // fields but a `paymentUri` deep-linking to a different
        // destination. See the module doc's money-safety §3.
        if (payment.method !== 'credit') {
          const parsed = parseSep7DestinationAndMemo(payment.paymentUri);
          if (
            parsed === null ||
            parsed.destination !== order.stellarAddress ||
            parsed.memo !== order.paymentMemo
          ) {
            clearLoopPendingOrder();
            return;
          }
        }

        // Still valid — but a fresher order may have been created for
        // this merchant while this GET was in flight (e.g. the user
        // tapped "Buy" again before the restore check resolved). Don't
        // let a stale TTL-refresh clobber it in storage: only refresh
        // if the record currently on disk is still the one we just
        // validated.
        const stillCurrent = await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY);
        const stillCurrentOrderId =
          stillCurrent !== null && typeof stillCurrent === 'object'
            ? (stillCurrent as Record<string, unknown>).orderId
            : undefined;
        if (cancelled) return;
        if (stillCurrentOrderId !== undefined && stillCurrentOrderId !== persisted.orderId) {
          // Superseded by a newer order — restoring the old one would
          // be wrong even though it's still a real, still-payable order
          // of the caller's. Leave storage alone and skip restoring.
          return;
        }

        // Refresh the TTL so a long-paying (or slow procuring) order
        // surviving multiple remounts doesn't fall out of the recovery
        // window.
        saveLoopPendingOrder({
          merchantId,
          orderId: persisted.orderId,
          create: persisted.create,
        });
        if (!cancelled) setRestored({ create: persisted.create });
      } catch (err) {
        if (cancelled) return;
        // 404 (not found / not owned — e.g. a different account signed
        // in on this device) or 401/403: this order isn't recoverable
        // for the current session — clear it. Any other error (network
        // blip, 5xx) leaves the persisted record alone so a future
        // remount gets another chance rather than losing a genuinely
        // live order to a transient failure.
        if (
          err instanceof ApiException &&
          (err.status === 404 || err.status === 401 || err.status === 403)
        ) {
          clearLoopPendingOrder();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [merchantId, enabled]);

  return { restored };
}
