import { create } from 'zustand';
import { storeRefreshToken, storeEmail, clearRefreshToken } from '~/native/secure-storage';

// Synchronous "was-authed" hint. Secure-storage reads are async, so on
// cold boot we can't know instantly whether the user has a refresh
// token — but we can stash a non-sensitive breadcrumb in localStorage
// that the boot path checks to decide whether to skip the splash and
// render home optimistically. Not a security boundary; the real auth
// still depends on the refresh token in Keychain / EncryptedSharedPrefs.
const WAS_AUTHED_KEY = 'loop_was_authed';
const setWasAuthed = (v: boolean): void => {
  try {
    if (v) localStorage.setItem(WAS_AUTHED_KEY, 'true');
    else localStorage.removeItem(WAS_AUTHED_KEY);
  } catch {
    /* storage disabled — ignore */
  }
};
export const wasAuthedLastSession = (): boolean => {
  try {
    return localStorage.getItem(WAS_AUTHED_KEY) === 'true';
  } catch {
    return false;
  }
};

interface AuthState {
  email: string | null;
  /** Access token — memory only. Never persisted. */
  accessToken: string | null;
}

interface AuthActions {
  setSession: (email: string, accessToken: string, refreshToken: string | null) => void;
  setAccessToken: (token: string) => void;
  clearSession: () => void;
}

/**
 * Authentication state store.
 *
 * Access tokens are held in memory only.
 * Refresh tokens are stored via the platform-appropriate secure storage:
 * Keychain / EncryptedSharedPreferences on native via
 * `@aparajita/capacitor-secure-storage` (audit A-024, ADR-006),
 * sessionStorage on web.
 */
export const useAuthStore = create<AuthState & AuthActions>((set) => ({
  email: null,
  accessToken: null,

  setSession: (email, accessToken, refreshToken) => {
    if (refreshToken !== null) {
      void storeRefreshToken(refreshToken);
    }
    void storeEmail(email);
    setWasAuthed(true);
    set({ email, accessToken });
  },

  setAccessToken: (token) => {
    setWasAuthed(true);
    set({ accessToken: token });
  },

  clearSession: () => {
    void clearRefreshToken();
    setWasAuthed(false);
    set({ email: null, accessToken: null });
  },
}));
