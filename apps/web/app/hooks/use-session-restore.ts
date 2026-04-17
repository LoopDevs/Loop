import { useEffect, useState } from 'react';
import { useAuthStore } from '~/stores/auth.store';
import { validatePersistedPurchase } from '~/stores/purchase.store';

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

    // Guard against setState-after-unmount. If the component unmounts while
    // the async IIFE is still running, every `setIsRestoring` call would
    // warn (React 18) or be silently dropped (React 19). Flag here and
    // gate each setState.
    let cancelled = false;

    void (async () => {
      try {
        const { getRefreshToken, getEmail } = await import('~/native/secure-storage');
        const refreshToken = await getRefreshToken();
        const email = await getEmail();

        if (cancelled) return;

        if (refreshToken === null) {
          setIsRestoring(false);
          return;
        }

        // Delegate to the shared tryRefresh so this call participates in the
        // same in-flight coalescing as any concurrent authenticatedRequest()
        // that also hits /refresh. Without this, mount-time session-restore
        // and an early authenticated query race to rotate the refresh token.
        const { tryRefresh } = await import('~/services/api-client');
        const accessToken = await tryRefresh();

        if (cancelled) return;

        if (accessToken !== null) {
          store.setAccessToken(accessToken);
          if (email) {
            // Restore email to store without re-storing tokens
            useAuthStore.setState({ email });
          }
        }
      } catch {
        // Refresh failed — user will need to log in again
      }

      // Also restore any pending purchase (native Preferences survive app kill)
      try {
        const { loadPendingOrder } = await import('~/native/purchase-storage');
        const pending = await loadPendingOrder();
        if (cancelled) return;
        const validated = validatePersistedPurchase(pending);
        if (validated !== null) {
          const { usePurchaseStore } = await import('~/stores/purchase.store');
          usePurchaseStore.setState(validated);
        }
      } catch {
        // purchase restore failed — not critical
      } finally {
        if (!cancelled) setIsRestoring(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { isRestoring };
}
