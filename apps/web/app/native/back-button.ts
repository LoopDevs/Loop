import { Capacitor } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

/**
 * Registers the Android hardware/gesture back button handler and
 * returns a disposer that removes the listener. The caller MUST
 * invoke the disposer on unmount — without it, every time the
 * registering effect re-runs (e.g. NativeShell unmounts on
 * sign-out and re-mounts on sign-in) another Capacitor listener
 * is appended and they all fire on the next back gesture,
 * triggering N `history.back()` calls and skipping past multiple
 * history entries at once.
 */
export function registerBackButton(): () => void {
  if (!Capacitor.isNativePlatform()) return () => {};

  let handle: PluginListenerHandle | null = null;
  let disposed = false;

  void (async () => {
    const { App } = await import('@capacitor/app');
    const listener = await App.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack) {
        window.history.back();
      } else {
        void App.exitApp();
      }
    });
    if (disposed) {
      // Caller already disposed — tear down immediately so we don't
      // leak a listener past the component's lifetime.
      void listener.remove();
      return;
    }
    handle = listener;
  })();

  return () => {
    disposed = true;
    void handle?.remove();
  };
}
