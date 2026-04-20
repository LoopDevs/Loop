import { Capacitor } from '@capacitor/core';

const REFRESH_TOKEN_KEY = 'loop_refresh_token';
const EMAIL_KEY = 'loop_user_email';

/**
 * Audit A-024: native refresh tokens and the user's email are persisted
 * via `@aparajita/capacitor-secure-storage`, which is Keychain-backed
 * on iOS (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`) and
 * AES-256-encrypted-via-Android-Keystore on Android. The previous
 * `@capacitor/preferences` path was plaintext `NSUserDefaults` /
 * `SharedPreferences` and contradicted the standards doc's "Capacitor
 * secure storage only" rule. See
 * `docs/adr/006-keychain-backed-secure-storage.md`.
 *
 * A one-shot migration below sweeps any Preferences-backed value into
 * SecureStorage on first read post-upgrade, so existing logged-in
 * users survive the change without a forced re-login.
 *
 * Web still uses `sessionStorage` — the audit was mobile-only, the
 * session-scoped semantics on web are still appropriate, and there is
 * no equivalent browser primitive.
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
// access and forward unknown calls to the native bridge. Returning one
// directly from an `async` function triggers Promise thenable resolution,
// which calls `.then(resolve, reject)` on the Proxy — the bridge then
// treats that as a native method call named "then" and rejects with
// `"SecureStorage.then()" is not implemented on android`. Wrap the
// plugin in a plain façade so the Promise machinery sees a non-thenable.
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

/**
 * Read a native-side value: consult SecureStorage first, then one-shot
 * migrate from Preferences if present (so this upgrade doesn't log
 * every user out). Called by `getRefreshToken` and `getEmail`.
 */
async function nativeReadWithMigration(key: string): Promise<string | null> {
  const secure = await loadSecureStorage();
  const existing = await secure.get(key);
  if (existing !== null) return existing;

  // Fallback: check the legacy Preferences-backed location. On a fresh
  // install this is a no-op; on upgrade it moves the value into the
  // keychain-backed store and wipes the plaintext copy.
  const prefs = await loadPreferences();
  const legacy = await prefs.get({ key });
  if (legacy.value === null) return null;

  await secure.set(key, legacy.value);
  await prefs.remove({ key });
  return legacy.value;
}

/**
 * Stores the refresh token in the appropriate location for the platform:
 * - Native (iOS/Android): Keychain / EncryptedSharedPreferences via
 *   `@aparajita/capacitor-secure-storage` (audit A-024).
 * - Web: sessionStorage (session-scoped, cleared on tab close).
 */
export async function storeRefreshToken(token: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const secure = await loadSecureStorage();
    await secure.set(REFRESH_TOKEN_KEY, token);
    return;
  }
  try {
    sessionStorage.setItem(REFRESH_TOKEN_KEY, token);
  } catch {
    // sessionStorage unavailable (e.g. cross-origin iframe) — skip
  }
}

/** Reads the stored refresh token. Returns null if not found. */
export async function getRefreshToken(): Promise<string | null> {
  if (Capacitor.isNativePlatform()) {
    return nativeReadWithMigration(REFRESH_TOKEN_KEY);
  }
  try {
    return sessionStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Removes the stored refresh token and email. */
export async function clearRefreshToken(): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const secure = await loadSecureStorage();
    await secure.remove(REFRESH_TOKEN_KEY);
    await secure.remove(EMAIL_KEY);
    // Also sweep any residue left in Preferences from the pre-migration
    // era, so a forgot-to-migrate reader never resurrects a stale token.
    const prefs = await loadPreferences();
    await prefs.remove({ key: REFRESH_TOKEN_KEY });
    await prefs.remove({ key: EMAIL_KEY });
    return;
  }
  try {
    sessionStorage.removeItem(REFRESH_TOKEN_KEY);
    sessionStorage.removeItem(EMAIL_KEY);
  } catch {
    // ignore
  }
}

/** Stores the user email for session restoration. */
export async function storeEmail(email: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const secure = await loadSecureStorage();
    await secure.set(EMAIL_KEY, email);
    return;
  }
  try {
    sessionStorage.setItem(EMAIL_KEY, email);
  } catch {
    // sessionStorage unavailable
  }
}

/** Reads the stored email. Returns null if not found. */
export async function getEmail(): Promise<string | null> {
  if (Capacitor.isNativePlatform()) {
    return nativeReadWithMigration(EMAIL_KEY);
  }
  try {
    return sessionStorage.getItem(EMAIL_KEY);
  } catch {
    return null;
  }
}
