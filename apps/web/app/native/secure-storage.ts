import { Capacitor } from '@capacitor/core';

const REFRESH_TOKEN_KEY = 'loop_refresh_token';
const EMAIL_KEY = 'loop_user_email';

/**
 * Stores the refresh token in the appropriate location for the platform:
 * - Native (iOS/Android): Capacitor Preferences (backed by Keychain/Keystore in P2)
 * - Web: sessionStorage (session-scoped, cleared on tab close)
 */
export async function storeRefreshToken(token: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.set({ key: REFRESH_TOKEN_KEY, value: token });
  } else {
    try {
      sessionStorage.setItem(REFRESH_TOKEN_KEY, token);
    } catch {
      // sessionStorage unavailable (e.g. cross-origin iframe) — skip
    }
  }
}

/** Reads the stored refresh token. Returns null if not found. */
export async function getRefreshToken(): Promise<string | null> {
  if (Capacitor.isNativePlatform()) {
    const { Preferences } = await import('@capacitor/preferences');
    const { value } = await Preferences.get({ key: REFRESH_TOKEN_KEY });
    return value;
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
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.remove({ key: REFRESH_TOKEN_KEY });
    await Preferences.remove({ key: EMAIL_KEY });
  } else {
    try {
      sessionStorage.removeItem(REFRESH_TOKEN_KEY);
      sessionStorage.removeItem(EMAIL_KEY);
    } catch {
      // ignore
    }
  }
}

/** Stores the user email for session restoration. */
export async function storeEmail(email: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.set({ key: EMAIL_KEY, value: email });
  } else {
    try {
      sessionStorage.setItem(EMAIL_KEY, email);
    } catch {
      // sessionStorage unavailable
    }
  }
}

/** Reads the stored email. Returns null if not found. */
export async function getEmail(): Promise<string | null> {
  if (Capacitor.isNativePlatform()) {
    const { Preferences } = await import('@capacitor/preferences');
    const { value } = await Preferences.get({ key: EMAIL_KEY });
    return value;
  }

  try {
    return sessionStorage.getItem(EMAIL_KEY);
  } catch {
    return null;
  }
}
