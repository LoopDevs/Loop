import { Capacitor } from '@capacitor/core';

/**
 * Storage key for pending order state. Exported so stores/purchase.store.ts
 * can read the same key from sessionStorage on synchronous init without
 * duplicating the literal string.
 */
export const PENDING_ORDER_KEY = 'loop_pending_order';
/** Default expiry window for a saved pending order if caller doesn't set one. */
const DEFAULT_EXPIRY_SECONDS = 15 * 60; // 15 minutes

/**
 * Saves pending order state for recovery after app kill.
 *
 * `loadPendingOrder` requires `expiresAt` (unix seconds) and returns null
 * for records without one — a silent no-op footgun if the caller forgets.
 * Default to now + 15min so a caller that omits expiresAt still gets a
 * functional round-trip. Callers can override by including their own.
 */
export async function savePendingOrder(data: Record<string, unknown>): Promise<void> {
  const payload =
    typeof data.expiresAt === 'number'
      ? data
      : { ...data, expiresAt: Math.floor(Date.now() / 1000) + DEFAULT_EXPIRY_SECONDS };
  const json = JSON.stringify(payload);
  if (Capacitor.isNativePlatform()) {
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.set({ key: PENDING_ORDER_KEY, value: json });
  } else {
    try {
      sessionStorage.setItem(PENDING_ORDER_KEY, json);
    } catch {
      /* sessionStorage unavailable */
    }
  }
}

/** Loads pending order state. Returns null if not found or expired. */
export async function loadPendingOrder(): Promise<Record<string, unknown> | null> {
  let raw: string | null = null;

  if (Capacitor.isNativePlatform()) {
    const { Preferences } = await import('@capacitor/preferences');
    const { value } = await Preferences.get({ key: PENDING_ORDER_KEY });
    raw = value;
  } else {
    try {
      raw = sessionStorage.getItem(PENDING_ORDER_KEY);
    } catch {
      /* sessionStorage unavailable */
    }
  }

  if (!raw) return null;

  let data: Record<string, unknown> | null = null;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Invalid JSON — corrupt record, clean it up so we don't keep
    // failing to parse on every cold start.
    void clearPendingOrder();
    return null;
  }

  // Not expired (most common path) — return the data.
  if (typeof data.expiresAt === 'number' && data.expiresAt > Math.floor(Date.now() / 1000)) {
    return data;
  }

  // A4-056: a record without a parseable `expiresAt` USED to be
  // destroyed silently here, taking a legacy-client pending order
  // with it (the user couldn't recover the payment instructions).
  // Now: when expiresAt is missing or non-numeric, fall through
  // to the recovery path with a synthesised default expiry —
  // matches `savePendingOrder`'s defaulting on the write side.
  // The record is retained so the next cold start has another
  // chance to honour it; the user's purchase isn't silently lost.
  if (typeof data.expiresAt !== 'number') {
    return { ...data, expiresAt: Math.floor(Date.now() / 1000) + DEFAULT_EXPIRY_SECONDS };
  }

  // Genuinely expired record — clean it up.
  void clearPendingOrder();
  return null;
}

/** Clears pending order state. */
export async function clearPendingOrder(): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.remove({ key: PENDING_ORDER_KEY });
  } else {
    try {
      sessionStorage.removeItem(PENDING_ORDER_KEY);
    } catch {
      /* sessionStorage unavailable */
    }
  }
}
