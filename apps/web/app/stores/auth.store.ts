import { create } from 'zustand';
import {
  storeRefreshToken,
  storeAccessToken,
  storeEmail,
  clearRefreshToken,
} from '~/native/secure-storage';

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
  /**
   * Access token. Held in memory for request stamping AND mirrored to
   * platform storage (sessionStorage web / SecureStorage native) so a
   * reload restores the session synchronously when the token's `exp`
   * is still in the future — no refresh round trip. The refresh token
   * remains the durable credential; this mirror is an optimisation
   * with the same storage trust boundary as the refresh token that
   * already lives there.
   */
  accessToken: string | null;
  /**
   * FE-10: has the cold-boot session-restore attempt finished?
   *
   * `false` until `useSessionRestore` resolves its restore attempt
   * (success OR failure), then `true` for the rest of the session.
   * Access tokens live in memory only, so on a hard reload `accessToken`
   * is briefly `null` for an *already-authenticated* user while the
   * refresh-token restore is in flight. Auth guards need to tell that
   * "don't-know-yet" window apart from "restore done, genuinely logged
   * out": without this flag `RequireStaff` reads `!isAuthenticated`
   * mid-restore and flashes the sign-in prompt before flipping to the
   * admin content. Not a security signal — the real authz decision still
   * gates on the access token and the `/me` staff role.
   */
  restoreComplete: boolean;
}

interface AuthActions {
  setSession: (email: string, accessToken: string, refreshToken: string | null) => void;
  setAccessToken: (token: string) => void;
  clearSession: () => void;
  /** Marks the cold-boot restore attempt complete (see `restoreComplete`). Idempotent. */
  setRestoreComplete: () => void;
}

/**
 * Authentication state store.
 *
 * Both tokens are stored via the platform-appropriate secure storage:
 * Keychain / EncryptedSharedPreferences on native via
 * `@aparajita/capacitor-secure-storage` (audit A-024, ADR-006),
 * sessionStorage on web. The access token is additionally held in
 * memory (this store) as the hot copy every request reads; the
 * persisted mirror exists so `use-session-restore` can resume a
 * still-fresh session on reload without a refresh call.
 */
export const useAuthStore = create<AuthState & AuthActions>((set) => ({
  email: null,
  accessToken: null,
  restoreComplete: false,

  setSession: (email, accessToken, refreshToken) => {
    if (refreshToken !== null) {
      void storeRefreshToken(refreshToken);
    }
    void storeAccessToken(accessToken);
    void storeEmail(email);
    setWasAuthed(true);
    set({ email, accessToken });
  },

  setAccessToken: (token) => {
    // Mirror every rotation to storage so the persisted copy never
    // lags the one requests are stamped with.
    void storeAccessToken(token);
    setWasAuthed(true);
    set({ accessToken: token });
  },

  clearSession: () => {
    void clearRefreshToken();
    setWasAuthed(false);
    set({ email: null, accessToken: null });
  },

  // FE-10: the restore attempt is a one-shot per app load. Explicit
  // login/logout after boot don't reset this — we always know the auth
  // state definitively once the initial restore has run.
  setRestoreComplete: () => {
    set({ restoreComplete: true });
  },
}));

// A4-070: cross-tab logout. The was-authed key lives in localStorage,
// which fires `storage` events in OTHER tabs/windows when one tab
// removes it. Without this listener, signing out in tab A leaves
// tab B rendering optimistic-authed UI until its next refresh
// attempt fails. We mirror the removal as a session clear so every
// open tab transitions to logged-out at the same time.
//
// Refresh tokens live in sessionStorage (per-tab) so we can't share
// a re-authentication across tabs — but a logout *broadcast* is
// safe and the right default.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== WAS_AUTHED_KEY) return;
    if (event.newValue === null) {
      // Another tab cleared the was-authed flag → it logged out.
      // Drop in-memory access token + email here too. Don't call
      // clearRefreshToken — sessionStorage is per-tab so the OTHER
      // tab's clear didn't touch ours; the boot path will re-prompt
      // for OTP if there's no refresh token.
      useAuthStore.setState({ email: null, accessToken: null });
    }
  });
}
