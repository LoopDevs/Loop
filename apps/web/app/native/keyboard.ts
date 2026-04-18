import { Capacitor } from '@capacitor/core';

/**
 * iOS-only helper: show the "Done / Previous / Next" keyboard accessory
 * bar. No-op on web and Android. The plugin is dynamically imported so
 * the web bundle does not pull in @capacitor/keyboard.
 *
 * Failures (missing plugin on a stripped build, permission issues) are
 * swallowed — the bar is a nice-to-have, not a feature gate. Callers
 * can await this safely without a try/catch.
 */
export async function setKeyboardAccessoryBarVisible(isVisible: boolean): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  if (Capacitor.getPlatform() !== 'ios') return;
  try {
    const { Keyboard } = await import('@capacitor/keyboard');
    await Keyboard.setAccessoryBarVisible({ isVisible });
  } catch {
    /* Keyboard plugin not available on this build — ignore. */
  }
}
