import { create } from 'zustand';
import { storeRefreshToken, storeEmail, clearRefreshToken } from '~/native/secure-storage';

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
 * Refresh tokens are stored via the platform-appropriate secure storage
 * (Capacitor Preferences on mobile, sessionStorage on web).
 */
export const useAuthStore = create<AuthState & AuthActions>((set) => ({
  email: null,
  accessToken: null,

  setSession: (email, accessToken, refreshToken) => {
    if (refreshToken !== null) {
      void storeRefreshToken(refreshToken);
    }
    void storeEmail(email);
    set({ email, accessToken });
  },

  setAccessToken: (token) => set({ accessToken: token }),

  clearSession: () => {
    void clearRefreshToken();
    set({ email: null, accessToken: null });
  },
}));
