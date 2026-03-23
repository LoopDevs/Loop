import { Capacitor } from '@capacitor/core';

export type NetworkCallback = (connected: boolean) => void;

/** Watches network status changes. Returns an unsubscribe function. On web, uses navigator.onLine. */
export function watchNetwork(callback: NetworkCallback): () => void {
  if (Capacitor.isNativePlatform()) {
    let cleanup = (): void => {};
    void (async () => {
      const { Network } = await import('@capacitor/network');
      const handle = await Network.addListener('networkStatusChange', (status) => {
        callback(status.connected);
      });
      cleanup = () => {
        void handle.remove();
      };
      // Initial check
      const { connected } = await Network.getStatus();
      callback(connected);
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
