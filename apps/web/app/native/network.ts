import { Capacitor } from '@capacitor/core';

export type NetworkCallback = (connected: boolean) => void;

/** Watches network status changes. Returns an unsubscribe function. On web, uses navigator.onLine. */
export function watchNetwork(callback: NetworkCallback): () => void {
  if (Capacitor.isNativePlatform()) {
    // Cancellation flag — if unsubscribe is called before the async setup
    // completes, we skip addListener entirely rather than registering a
    // listener we can never clean up. Without this flag, a fast-unmounting
    // component could leak a Network listener for the rest of the process.
    let cancelled = false;
    let cleanup = (): void => {
      cancelled = true;
    };
    void (async () => {
      const { Network } = await import('@capacitor/network');
      if (cancelled) return;
      const handle = await Network.addListener('networkStatusChange', (status) => {
        callback(status.connected);
      });
      if (cancelled) {
        void handle.remove();
        return;
      }
      cleanup = () => {
        cancelled = true;
        void handle.remove();
      };
      // Initial check
      const { connected } = await Network.getStatus();
      if (!cancelled) callback(connected);
    })();
    return () => cleanup();
  }

  // Web fallback
  const onOnline = (): void => callback(true);
  const onOffline = (): void => callback(false);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  callback(navigator.onLine);
  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
  };
}
