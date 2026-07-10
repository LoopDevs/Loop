import { useEffect, useState } from 'react';
import { ApiException, type LoopAssetCode } from '@loop/shared';
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
  type LoopOrderView,
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
 * server-side (real order row, real deposit memo). This hook lets
 * `PurchaseContainer` re-hydrate `loopCreate` on the next mount instead
 * of silently losing it. Mirrors `useSessionRestore`'s pending-purchase
 * restore for the legacy CTX-proxy path.
 *
 * SERVER-AUTHORITATIVE by construction (Q6-4b hardening). What we persist
 * to sessionStorage / Keychain is a POINTER only — `{ merchantId, orderId }`
 * — never any payment-directing value. On restore we GET the order
 * (`GET /api/orders/loop/:id`, owner-scoped) and rebuild the ENTIRE pay
 * screen from that server response's fields (`stellarAddress`,
 * `paymentMemo`, `assetAmount`, `paymentUri`, `assetCode`, `assetIssuer`
 * — the last four re-quoted server-side, see the read handler). NOTHING
 * that directs a payment (destination, memo, amount, asset, deep-link)
 * ever comes from client storage, so there is no client-side field to
 * tamper: an attacker with sessionStorage/Keychain write access can at
 * most change the `orderId` we look up, and:
 *   - an unknown / other-user id → owner-scoped GET 404s → we clear it;
 *   - a different order the SAME user owns → the server rebuilds THAT
 *     order's real payment payload → still safe (it's the caller's own
 *     order, its own real deposit address/amount).
 *
 * Money-safety:
 *   1. Read-only — only ever `GET /api/orders/loop/:id`, never
 *      `POST /api/orders/loop`, so a restore can never create a
 *      duplicate order.
 *   2. Refuses to restore a terminal order (fulfilled/failed/expired) —
 *      those belong on order history, not a resurrected pay form — and
 *      clears the pointer.
 *   3. Fail-closed: a 404/401/403 clears the pointer; any other error
 *      (5xx/network) leaves it for a later remount to retry.
 */

interface UseLoopOrderRestoreArgs {
  /** The merchant currently being viewed — restore only applies to a
   *  persisted pointer scoped to this exact merchant. */
  merchantId: string;
  /** Gate the restore attempt (pass `isAuthenticated && loopOrdersEnabled`)
   *  so this never fires a doomed fetch while signed out or the
   *  loop-native path is off. */
  enabled: boolean;
}

export interface LoopOrderRestoreResult {
  create: CreateLoopOrderResponse;
}

/** Recovery window for a persisted pointer. Generous enough to cover a
 *  slow crypto deposit + procurement; short enough that an order
 *  abandoned mid-flow doesn't resurrect indefinitely on an unrelated
 *  later visit. Refreshed on every successful restore, so a long-lived
 *  but still-live order surviving several remounts doesn't age out
 *  mid-payment. */
export const LOOP_PENDING_ORDER_TTL_SECONDS = 20 * 60;

/** The persisted pointer — merchant + order id ONLY. Deliberately carries
 *  no payment-directing value (see the module doc): the pay screen is
 *  rebuilt from the server GET, never from this. */
interface PersistedLoopOrderPointer {
  merchantId: string;
  orderId: string;
}

/**
 * Persists a pointer to the just-created order so a later remount can
 * restore it. Call right after `setLoopCreate(result)` in
 * `PurchaseContainer` with the order's id + merchant.
 *
 * Sets `expiresAt` explicitly to `LOOP_PENDING_ORDER_TTL_SECONDS` out —
 * `savePendingOrder`'s generic storage layer (`purchase-storage.ts`)
 * defaults to its OWN 15-minute `DEFAULT_EXPIRY_SECONDS` for a record
 * that omits `expiresAt`, which would silently undercut this module's
 * documented 20-minute recovery window.
 */
export function saveLoopPendingOrder(record: PersistedLoopOrderPointer): void {
  const now = Math.floor(Date.now() / 1000);
  enqueuePersist(() =>
    savePendingOrder(
      {
        merchantId: record.merchantId,
        orderId: record.orderId,
        savedAt: now,
        expiresAt: now + LOOP_PENDING_ORDER_TTL_SECONDS,
      },
      LOOP_NATIVE_PENDING_ORDER_KEY,
    ),
  );
}

/** Clears the persisted pointer. Call on terminal state (fulfilled /
 *  failed / expired) and on a not-found/forbidden restore GET. */
export function clearLoopPendingOrder(): void {
  enqueuePersist(() => clearPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY));
}

// Serializes save/clear through one promise chain, same rationale as
// purchase.store.ts's `enqueuePersist` — a clear issued right after a
// save could otherwise resolve first on native Capacitor storage,
// leaving a stale pointer behind.
let persistQueue: Promise<unknown> = Promise.resolve();
function enqueuePersist(op: () => Promise<void>): void {
  persistQueue = persistQueue.catch(() => {}).then(op);
  void persistQueue;
}

/**
 * Validates the persisted pointer: it must be an object with string
 * `merchantId` (matching the merchant currently being viewed) + string
 * `orderId`, within the TTL. Returns null otherwise. Deliberately reads
 * ONLY those two identifiers — any extra keys a tampered record carries
 * (e.g. a stale `create` blob from before this became pointer-only, or an
 * attacker-injected amount) are ignored, never consumed.
 */
export function validatePersistedLoopOrder(
  data: unknown,
  expectedMerchantId: string,
): PersistedLoopOrderPointer | null {
  if (data === null || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.merchantId !== 'string' || d.merchantId !== expectedMerchantId) return null;
  if (typeof d.orderId !== 'string' || d.orderId.length === 0) return null;
  if (typeof d.savedAt !== 'number' || !Number.isFinite(d.savedAt)) return null;
  if (d.savedAt + LOOP_PENDING_ORDER_TTL_SECONDS <= Math.floor(Date.now() / 1000)) return null;
  return { merchantId: d.merchantId, orderId: d.orderId };
}

/**
 * Rebuilds the `CreateLoopOrderResponse` (`LoopPaymentStep`'s `create`
 * prop) ENTIRELY from a server `LoopOrderView`. This is the whole
 * money-safety story: every payment-directing field comes from the
 * server response, none from client storage.
 *
 * Returns null when the server didn't supply enough to render a pay
 * screen — a credit order that isn't `credit` (impossible), or an
 * on-chain order whose server-derived guidance fields are absent (oracle
 * down / issuer unset at read time, or a terminal order the caller should
 * not be resuming). A null result means "can't resume right now"; the
 * caller leaves the pointer in place so a later remount can retry once
 * the server can derive the guidance.
 */
export function loopOrderViewToCreate(view: LoopOrderView): CreateLoopOrderResponse | null {
  if (view.paymentMethod === 'credit') {
    return {
      orderId: view.id,
      payment: {
        method: 'credit',
        amountMinor: view.chargeMinor,
        currency: view.chargeCurrency,
      },
    };
  }
  // On-chain: require the full server-derived payment guidance. Any
  // missing field means we cannot render a corroborated pay screen.
  if (
    view.stellarAddress === null ||
    view.paymentMemo === null ||
    view.assetAmount === null ||
    view.paymentUri === null
  ) {
    return null;
  }
  if (view.paymentMethod === 'loop_asset') {
    if (view.assetCode === null || view.assetIssuer === null) return null;
    return {
      orderId: view.id,
      payment: {
        method: 'loop_asset',
        stellarAddress: view.stellarAddress,
        memo: view.paymentMemo,
        amountMinor: view.chargeMinor,
        currency: view.chargeCurrency,
        // The server only ever writes a valid LoopAssetCode here.
        assetCode: view.assetCode as LoopAssetCode,
        assetIssuer: view.assetIssuer,
        assetAmount: view.assetAmount,
        paymentUri: view.paymentUri,
      },
    };
  }
  // xlm / usdc
  return {
    orderId: view.id,
    payment: {
      method: view.paymentMethod,
      stellarAddress: view.stellarAddress,
      memo: view.paymentMemo,
      amountMinor: view.chargeMinor,
      currency: view.chargeCurrency,
      assetAmount: view.assetAmount,
      paymentUri: view.paymentUri,
    },
  };
}

/**
 * Restore hook — see module doc above. Fires once per
 * `(merchantId, enabled)` pair; returns `{ create }` (rebuilt entirely
 * from the server) once a persisted pointer resolves to a live,
 * caller-owned, non-terminal order, or stays `null` (the common case —
 * no pointer, or nothing left to restore).
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
        const pointer = validatePersistedLoopOrder(raw, merchantId);
        if (pointer === null) return;

        const order = await getLoopOrder(pointer.orderId);
        if (cancelled) return;

        if (order.merchantId !== merchantId || isLoopOrderTerminal(order.state)) {
          clearLoopPendingOrder();
          return;
        }

        // Rebuild the pay screen ENTIRELY from the server response. If the
        // server couldn't derive the on-chain guidance (oracle down /
        // issuer unset at read time), don't restore — but leave the
        // pointer so a later remount retries once the server can derive.
        const create = loopOrderViewToCreate(order);
        if (create === null) return;

        // A fresher order may have been created for this merchant while
        // this GET was in flight (e.g. the user tapped "Buy" again before
        // the restore resolved). Don't let a stale TTL-refresh clobber the
        // newer pointer, and don't restore the older order.
        const stillCurrent = await loadPendingOrder(LOOP_NATIVE_PENDING_ORDER_KEY);
        const stillCurrentOrderId =
          stillCurrent !== null && typeof stillCurrent === 'object'
            ? (stillCurrent as Record<string, unknown>).orderId
            : undefined;
        if (cancelled) return;
        if (stillCurrentOrderId !== undefined && stillCurrentOrderId !== pointer.orderId) {
          return;
        }

        // Refresh the TTL so a long-paying (or slow procuring) order
        // surviving multiple remounts doesn't fall out of the window.
        saveLoopPendingOrder({ merchantId, orderId: pointer.orderId });
        if (!cancelled) setRestored({ create });
      } catch (err) {
        if (cancelled) return;
        // 404 (not found / not owned — e.g. a different account signed in
        // on this device, or a tampered/stale order id) or 401/403: not
        // recoverable for this session — clear the pointer. Any other
        // error (network blip, 5xx) leaves it so a future remount retries
        // rather than losing a genuinely live order to a transient failure.
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
