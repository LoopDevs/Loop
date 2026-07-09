import { Capacitor } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import { focusManager } from '@tanstack/react-query';

/**
 * Registers the `@capacitor/app` `appStateChange` listener (M-5) and
 * pipes foreground/background transitions into TanStack Query's
 * `focusManager`, then returns a disposer. Mirrors `registerBackButton`
 * / `registerDeepLinks`'s dynamic-import + disposer shape exactly — see
 * `back-button.ts`'s doc comment for why the disposer must be called on
 * unmount.
 *
 * Why this is needed at all: TanStack Query's default focus detection
 * is `window` `focus` / `document` `visibilitychange` events, which
 * never fire when a Capacitor app is backgrounded/foregrounded — the
 * WKWebView/WebView keeps "focus" from the DOM's perspective the whole
 * time, it's the OS-level app switch that changes. Without this,
 * `refetchOnWindowFocus` (already relied on elsewhere — see
 * `docs/mobile-native-ux.md`'s pull-to-refresh entry) is a dead
 * feature on native: queries never look stale on resume, so a user who
 * backgrounds the app for an hour and comes back sees minute-old data
 * with no refetch trigger. `focusManager.setFocused(isActive)` is the
 * documented TanStack Query hook for exactly this — feeding it a
 * platform-specific focus signal.
 *
 * Deliberately NOT touching app-lock semantics — `registerAppLockGuard`
 * (`./app-lock.ts`) stays cold-start-only by its own separate design
 * choice (see that file's comment). This module only affects query
 * freshness, not the biometric lock screen.
 */
export function registerAppStateSync(): () => void {
  if (!Capacitor.isNativePlatform()) return () => {};

  let handle: PluginListenerHandle | null = null;
  let disposed = false;

  void (async () => {
    const { App } = await import('@capacitor/app');
    const listener = await App.addListener('appStateChange', ({ isActive }) => {
      focusManager.setFocused(isActive);
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
