import { useEffect, useState } from 'react';
import { useAuthStore } from '~/stores/auth.store';

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
      const { getAccessToken, getRefreshToken, getEmail } = await import('~/native/secure-storage');
      const [storedAccessToken, refreshToken, email] = await Promise.all([
        getAccessToken(),
        getRefreshToken(),
        getEmail(),
      ]);

      const { isJwtExpired } = await import('~/utils/jwt-expiry');

      // Fast path: the persisted access token is still inside its
      // `exp` (with skew) — resume the session with zero network.
      // This is the common reload case; the refresh call below is
      // reserved for genuinely stale sessions.
      if (storedAccessToken !== null && !isJwtExpired(storedAccessToken)) {
        useAuthStore.getState().setAccessToken(storedAccessToken);
        if (email) useAuthStore.setState({ email });
        return;
      }

      if (refreshToken === null) return;

      // Both tokens carry a decodable `exp` (Loop and CTX both mint
      // JWTs). When the refresh token is ALSO past expiry there is no
      // credential left worth sending — skip the doomed round trip,
      // clear the dead session from storage, and let the boot path
      // land on the login screen directly.
      if (isJwtExpired(refreshToken)) {
        const { clearRefreshToken } = await import('~/native/secure-storage');
        await clearRefreshToken();
        return;
      }

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

/**
 * Attempts to restore the auth session from stored tokens on app
 * mount: a still-fresh persisted access token resumes the session
 * with no network; otherwise the stored refresh token rolls a new
 * pair; when both are expired the user lands on login directly.
 */
export function useSessionRestore(): { isRestoring: boolean } {
  const [isRestoring, setIsRestoring] = useState(true);
  const store = useAuthStore();

  useEffect(() => {
    // FE-10: mark BOTH the local restoring flag and the shared
    // auth-store `restoreComplete` flag. The store flag lets auth guards
    // (e.g. RequireStaff) that don't call this hook tell "restore still
    // in flight" apart from "restore done, genuinely logged out" — the
    // hard-reload sign-in flash. Success and failure both count as
    // "attempt finished".
    const markRestored = (): void => {
      setIsRestoring(false);
      useAuthStore.getState().setRestoreComplete();
    };

    // Only restore if not already authenticated
    if (store.accessToken !== null) {
      markRestored();
      return;
    }

    // Guard against setState-after-unmount.
    let cancelled = false;

    // Await the module-load boot restore (already in flight). Runs in
    // parallel with React hydration, so this await typically resolves
    // near-instantly on cold start.
    void getBootRestore().finally(() => {
      if (!cancelled) markRestored();
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { isRestoring };
}
