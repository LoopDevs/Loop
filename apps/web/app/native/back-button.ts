import { Capacitor } from '@capacitor/core';

/** Registers Android back button handler. Navigates back in history or exits. */
export function registerBackButton(): void {
  if (!Capacitor.isNativePlatform()) return;

  void (async () => {
    const { App } = await import('@capacitor/app');
    await App.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack) {
        window.history.back();
      } else {
        void App.exitApp();
      }
    });
  })();
}
