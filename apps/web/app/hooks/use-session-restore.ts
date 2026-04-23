import { useEffect, useState } from 'react';
import { useAuthStore } from '~/stores/auth.store';
import { validatePersistedPurchase } from '~/stores/purchase.store';

// Module-load parallel restore. React hydration on cold start takes
// ~1s on a mid-tier Android — we burn that wall-clock by firing the
// secure-storage read + /refresh network call here, before any
// component mounts. By the time the component useEffect runs, the
// work is already in flight (or complete) and we just await its
// promise. Measured ~460ms savings vs. starting on effect-mount.
let bootRestore: Promise<void> | null = null;
function getBootRestore(): Promise<void> {
  if (bootRestore !== null) return bootRestore;
  bootRestore = (async () => {
    try {
      const { getRefreshToken, getEmail } = await import('~/native/secure-storage');
      const [refreshToken, email] = await Promise.all([getRefreshToken(), getEmail()]);
      if (refreshToken === null) return;
      const { tryRefresh } = await import('~/services/api-client');
      const accessToken = await tryRefresh();
      if (accessToken !== null) {
        useAuthStore.getState().setAccessToken(accessToken);
        if (email) useAuthStore.setState({ email });
        return;
      }
      // A2-1150: do NOT call clearSession() here. tryRefresh returns
      // null for both "definitively rejected" (4xx-not-429 → doRefresh
      // already cleared storage in its catch branch) and "transient"
      // (5xx / 429 / network — storage deliberately kept on disk per
      // audit A-020). Calling clearSession on the transient path would
      // wipe the refresh token from Keychain / sessionStorage and
      // force a re-login even though the backend just had a blip.
      //
      // The auth store's accessToken was already null before boot
      // restore ran; leaving it null lets the UI render the login
      // screen while preserving the refresh token for a subsequent
      // launch to retry once upstream recovers.
    } catch {
      /* refresh failed — user will need to log in again */
    }
  })();
  return bootRestore;
}
// Fire-and-forget at module load so the work overlaps React hydration.
if (typeof window !== 'undefined') {
  void getBootRestore();
}

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

    // Guard against setState-after-unmount.
    let cancelled = false;

    // Await the module-load boot restore (already in flight). Runs in
    // parallel with React hydration, so this await typically resolves
    // near-instantly on cold start.
    void getBootRestore().finally(() => {
      if (!cancelled) setIsRestoring(false);
    });

    // Pending-purchase restore — independent of auth.
    void (async (): Promise<void> => {
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
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { isRestoring };
}
