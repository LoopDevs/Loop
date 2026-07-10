import { Capacitor } from '@capacitor/core';

/**
 * Storage key for pending order state (legacy CTX-proxy path). Exported so
 * stores/purchase.store.ts can read the same key from sessionStorage on
 * synchronous init without duplicating the literal string.
 */
export const PENDING_ORDER_KEY = 'loop_pending_order';
/**
 * Storage key for an in-progress loop-native order (ADR 010), consumed by
 * `~/hooks/use-loop-order-restore.ts`. Deliberately a SEPARATE key from
 * `PENDING_ORDER_KEY` above — the two paths persist differently-shaped
 * records (this one wraps a full `CreateLoopOrderResponse`, the legacy one
 * is a flat `paymentAddress`/`xlmAmount`/`memo` record), so sharing a key
 * risks one path's stale record being misread as the other's.
 */
export const LOOP_NATIVE_PENDING_ORDER_KEY = 'loop_native_pending_order';
/** Default expiry window for a saved pending order if caller doesn't set one. */
const DEFAULT_EXPIRY_SECONDS = 15 * 60; // 15 minutes

/**
 * A4-055: pending order state lives in keychain-backed secure storage
 * on native (iOS Keychain / Android EncryptedSharedPreferences via
 * `@aparajita/capacitor-secure-storage`, same plugin as refresh tokens
 * — see ADR-006 / `secure-storage.ts`). Earlier code wrote the order
 * memo + Stellar deposit address to plaintext `@capacitor/preferences`.
 *
 * The threat model: a payment memo + deposit address is enough for an
 * attacker with file-system access (jailbroken device, malicious
 * companion app on Android pre-scoped-storage) to reconstruct who
 * paid what to where. The values aren't secrets in the cryptographic
 * sense — the address is on-chain public, the memo is opaque to
 * outsiders — but they're personally-identifying purchase metadata,
 * which the privacy policy already commits to encrypting at rest.
 *
 * Web still uses `sessionStorage` — same posture as the refresh-token
 * path. The audit was mobile-only, the session-scoped semantics on
 * web are appropriate, and there is no equivalent browser primitive.
 *
 * One-shot migration on read: if SecureStorage is empty but Preferences
 * still has a value (legacy install pre-A4-055), copy it across and
 * wipe the plaintext copy. Existing users with a live pending order
 * survive the upgrade.
 */

type SecureStorageModule = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  remove: (key: string) => Promise<boolean>;
};

type PreferencesModule = {
  get: (opts: { key: string }) => Promise<{ value: string | null }>;
  set: (opts: { key: string; value: string }) => Promise<void>;
  remove: (opts: { key: string }) => Promise<void>;
};

// Capacitor plugin objects are Proxies that intercept every property
// access. Returning the plugin directly from an `async` function
// triggers Promise thenable resolution, which mis-routes `.then()` as
// a native method call. Wrap the plugin in a plain façade — same
// pattern as `secure-storage.ts`.
async function loadSecureStorage(): Promise<SecureStorageModule> {
  const mod = await import('@aparajita/capacitor-secure-storage');
  const impl = mod.SecureStorage as unknown as SecureStorageModule;
  return {
    get: (key) => impl.get(key),
    set: (key, value) => impl.set(key, value),
    remove: (key) => impl.remove(key),
  };
}

async function loadPreferences(): Promise<PreferencesModule> {
  const mod = await import('@capacitor/preferences');
  const impl = mod.Preferences as unknown as PreferencesModule;
  return {
    get: (opts) => impl.get(opts),
    set: (opts) => impl.set(opts),
    remove: (opts) => impl.remove(opts),
  };
}

async function nativeReadWithMigration(key: string): Promise<string | null> {
  const secure = await loadSecureStorage();
  const existing = await secure.get(key);
  if (existing !== null) return existing;

  // Fallback: check the legacy Preferences-backed location. On a fresh
  // install this is a no-op; on upgrade it moves the value into secure
  // storage and wipes the plaintext copy.
  const prefs = await loadPreferences();
  const legacy = await prefs.get({ key });
  if (legacy.value === null) return null;
  await secure.set(key, legacy.value);
  await prefs.remove({ key });
  return legacy.value;
}

/**
 * Saves pending order state for recovery after app kill.
 *
 * `loadPendingOrder` requires `expiresAt` (unix seconds) and returns null
 * for records without one — a silent no-op footgun if the caller forgets.
 * Default to now + 15min so a caller that omits expiresAt still gets a
 * functional round-trip. Callers can override by including their own.
 *
 * `key` defaults to the legacy CTX-proxy `PENDING_ORDER_KEY` — pass
 * `LOOP_NATIVE_PENDING_ORDER_KEY` (or any other key) to store under a
 * different namespace, e.g. `~/hooks/use-loop-order-restore.ts`.
 */
export async function savePendingOrder(
  data: Record<string, unknown>,
  key: string = PENDING_ORDER_KEY,
): Promise<void> {
  const payload =
    typeof data.expiresAt === 'number'
      ? data
      : { ...data, expiresAt: Math.floor(Date.now() / 1000) + DEFAULT_EXPIRY_SECONDS };
  const json = JSON.stringify(payload);
  if (Capacitor.isNativePlatform()) {
    const secure = await loadSecureStorage();
    await secure.set(key, json);
    // Belt-and-braces: if a Preferences record is still around from
    // before A4-055 (pre-migration), the next read would migrate it
    // and clobber the value we're writing now. Drop the legacy copy
    // here too so the secure-storage write is canonical.
    const prefs = await loadPreferences();
    await prefs.remove({ key });
    return;
  }
  try {
    sessionStorage.setItem(key, json);
  } catch {
    /* sessionStorage unavailable */
  }
}

/** Loads pending order state. Returns null if not found or expired. */
export async function loadPendingOrder(
  key: string = PENDING_ORDER_KEY,
): Promise<Record<string, unknown> | null> {
  let raw: string | null = null;

  if (Capacitor.isNativePlatform()) {
    raw = await nativeReadWithMigration(key);
  } else {
    try {
      raw = sessionStorage.getItem(key);
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
    void clearPendingOrder(key);
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
  void clearPendingOrder(key);
  return null;
}

/** Clears pending order state. */
export async function clearPendingOrder(key: string = PENDING_ORDER_KEY): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const secure = await loadSecureStorage();
    await secure.remove(key);
    // Sweep the legacy Preferences key too so a stale plaintext
    // copy from before A4-055 doesn't resurrect the order on the
    // next read.
    const prefs = await loadPreferences();
    await prefs.remove({ key });
    return;
  }
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* sessionStorage unavailable */
  }
}
