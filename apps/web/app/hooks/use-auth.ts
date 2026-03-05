import { useAuthStore } from '~/stores/auth.store';
import { requestOtp, verifyOtp, logout } from '~/services/auth';

export interface UseAuthResult {
  email: string | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  /** Request an OTP to be sent to the given email. */
  requestOtp: (email: string) => Promise<void>;
  /** Verify an OTP. Returns true if successful. */
  verifyOtp: (email: string, otp: string) => Promise<boolean>;
  /** Clears the local session. */
  logout: () => Promise<void>;
}

/** Returns auth state and auth actions. */
export function useAuth(): UseAuthResult {
  const store = useAuthStore();

  return {
    email: store.email,
    accessToken: store.accessToken,
    isAuthenticated: store.accessToken !== null,

    requestOtp: async (email: string) => {
      await requestOtp(email);
    },

    verifyOtp: async (email: string, otp: string) => {
      try {
        const { accessToken, refreshToken } = await verifyOtp(email, otp);
        store.setSession(email, accessToken, refreshToken ?? null);
        return true;
      } catch {
        return false;
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
