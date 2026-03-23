import { Capacitor } from '@capacitor/core';

/** Sets the status bar style. No-op on web. */
export async function setStatusBarStyle(style: 'light' | 'dark'): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setStyle({ style: style === 'dark' ? Style.Dark : Style.Light });
  }
}

/** Makes the status bar overlay the WebView (transparent background). */
export async function setStatusBarOverlay(): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const { StatusBar } = await import('@capacitor/status-bar');
    await StatusBar.setOverlaysWebView({ overlay: true });
  }
}
