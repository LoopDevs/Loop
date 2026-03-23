import { ApiException } from '@loop/shared';
import { useAuthStore } from '~/stores/auth.store';
import { requestOtp, verifyOtp, logout } from '~/services/auth';

export interface UseAuthResult {
  email: string | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  /** Request an OTP to be sent to the given email. Throws with user-facing message on failure. */
  requestOtp: (email: string) => Promise<void>;
  /** Verify an OTP. Stores tokens on success. Throws with user-facing message on failure. */
  verifyOtp: (email: string, otp: string) => Promise<void>;
  /** Clears the local session. */
  logout: () => Promise<void>;
}

/** Maps API errors to user-facing messages. */
function authErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiException) {
    if (err.status === 401) return 'Incorrect or expired code. Please try again.';
    if (err.status === 429) return 'Too many attempts. Please wait a moment.';
    if (err.status === 503) return 'Service temporarily unavailable. Please try again shortly.';
    if (err.status === 502) return 'Unable to reach the auth provider. Please try again.';
  }
  return fallback;
}

/** Returns auth state and auth actions. */
export function useAuth(): UseAuthResult {
  const store = useAuthStore();

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

    logout: async () => {
      try {
        await logout();
      } finally {
        store.clearSession();
      }
    },
  };
}
