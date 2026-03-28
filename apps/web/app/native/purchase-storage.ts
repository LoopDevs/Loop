import { Capacitor } from '@capacitor/core';

const PENDING_ORDER_KEY = 'loop_pending_order';

/** Saves pending order state for recovery after app kill. */
export async function savePendingOrder(data: Record<string, unknown>): Promise<void> {
  const json = JSON.stringify(data);
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

  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    // Only restore if not expired
    if (typeof data.expiresAt === 'number' && data.expiresAt > Math.floor(Date.now() / 1000)) {
      return data;
    }
  } catch {
    /* invalid JSON */
  }

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
