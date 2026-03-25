import { useEffect, useState } from 'react';
import { useAuthStore } from '~/stores/auth.store';

/** Attempts to restore the auth session from stored refresh token on app mount. */
export function useSessionRestore(): { isRestoring: boolean } {
  const [isRestoring, setIsRestoring] = useState(true);
  const store = useAuthStore();

  useEffect(() => {
    // Only restore if not already authenticated
    if (store.accessToken !== null) {
      setIsRestoring(false);
      return;
    }

    void (async () => {
      try {
        const { getRefreshToken, getEmail } = await import('~/native/secure-storage');
        const refreshToken = await getRefreshToken();
        const email = await getEmail();

        if (refreshToken === null) {
          setIsRestoring(false);
          return;
        }

        // Try to refresh
        const { getPlatform } = await import('~/native/platform');
        const { apiRequest } = await import('~/services/api-client');
        const platform = getPlatform();

        const res = await apiRequest<{ accessToken: string; refreshToken?: string }>(
          '/api/auth/refresh',
          { method: 'POST', body: { refreshToken, platform } },
        );

        if (res.refreshToken) {
          const { storeRefreshToken } = await import('~/native/secure-storage');
          void storeRefreshToken(res.refreshToken);
        }

        store.setAccessToken(res.accessToken);
        if (email) {
          // Restore email to store without re-storing tokens
          useAuthStore.setState({ email });
        }
      } catch {
        // Refresh failed — user will need to log in again
      } finally {
        setIsRestoring(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { isRestoring };
}
