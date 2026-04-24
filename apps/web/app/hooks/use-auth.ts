import { ApiException } from '@loop/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '~/stores/auth.store';
import { usePurchaseStore } from '~/stores/purchase.store';
import {
  requestOtp,
  verifyOtp,
  socialLoginGoogle,
  socialLoginApple,
  logout,
} from '~/services/auth';
import { friendlyError } from '~/utils/error-messages';

export interface UseAuthResult {
  email: string | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  /** Request an OTP to be sent to the given email. Throws with user-facing message on failure. */
  requestOtp: (email: string) => Promise<void>;
  /** Verify an OTP. Stores tokens on success. Throws with user-facing message on failure. */
  verifyOtp: (email: string, otp: string) => Promise<void>;
  /** Exchange a Google id_token for a Loop session. ADR 014. */
  signInWithGoogle: (idToken: string) => Promise<void>;
  /** Exchange an Apple id_token for a Loop session. ADR 014. */
  signInWithApple: (idToken: string) => Promise<void>;
  /** Clears the local session. */
  logout: () => Promise<void>;
}

/**
 * A2-1154: auth-surface translator is a thin overlay on `friendlyError`.
 * The overlay owns only the two messages where the auth context changes
 * the copy:
 *
 * - 401 means "wrong or expired OTP" on auth endpoints. `friendlyError`
 *   has no 401 mapping because for non-auth calls a 401 means the
 *   session expired and the caller redirects to sign-in — surfacing a
 *   user-visible message would be wrong.
 * - 502 overrides `friendlyError`'s generic "our provider is having
 *   trouble" with auth-specific copy; the user is trying to sign in, so
 *   naming "the auth provider" is less confusing than a bare "provider".
 *
 * Everything else (offline detection, TIMEOUT, NETWORK_ERROR, 429, 503,
 * 504) is inherited. Before this was a separate function, `/auth` (via
 * `useAuth`) and `/onboarding` (direct calls wrapped in `friendlyError`)
 * rendered different strings for the same backend response.
 */
function authErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiException) {
    if (err.status === 401) return 'Incorrect or expired code. Please try again.';
    if (err.status === 502) return 'Unable to reach the auth provider. Please try again.';
  }
  return friendlyError(err, fallback);
}

/** Returns auth state and auth actions. */
export function useAuth(): UseAuthResult {
  const store = useAuthStore();
  const queryClient = useQueryClient();

  return {
    email: store.email,
    accessToken: store.accessToken,
    isAuthenticated: store.accessToken !== null,

    requestOtp: async (email: string) => {
      try {
        await requestOtp(email);
      } catch (err) {
        throw new Error(
          authErrorMessage(err, 'Failed to send verification code. Please try again.'),
        );
      }
    },

    verifyOtp: async (email: string, otp: string) => {
      try {
        const { accessToken, refreshToken } = await verifyOtp(email, otp);
        store.setSession(email, accessToken, refreshToken ?? null);
      } catch (err) {
        throw new Error(authErrorMessage(err, 'Verification failed. Please try again.'));
      }
    },

    signInWithGoogle: async (idToken: string) => {
      try {
        const pair = await socialLoginGoogle(idToken);
        store.setSession(pair.email ?? '', pair.accessToken, pair.refreshToken);
      } catch (err) {
        throw new Error(authErrorMessage(err, 'Google sign-in failed. Please try again.'));
      }
    },

    signInWithApple: async (idToken: string) => {
      try {
        const pair = await socialLoginApple(idToken);
        store.setSession(pair.email ?? '', pair.accessToken, pair.refreshToken);
      } catch (err) {
        throw new Error(authErrorMessage(err, 'Apple sign-in failed. Please try again.'));
      }
    },

    logout: async () => {
      try {
        await logout();
      } finally {
        // A2-1151 + A2-1152: full local teardown. clearSession wipes
        // the auth store; we also reset the in-flight purchase state
        // (would otherwise leak a cart or pending order into the next
        // login) and clear the TanStack Query cache (would otherwise
        // serve the previous user's /me data on first render after
        // re-login until each query refetches).
        store.clearSession();
        usePurchaseStore.getState().reset();
        queryClient.clear();
      }
    },
  };
}
