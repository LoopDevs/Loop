import { Capacitor } from '@capacitor/core';

/**
 * Renders a JS-side blur overlay on the Capacitor `pause` event so the
 * iOS task-switcher snapshot of a sensitive screen (gift-card code,
 * Stellar secret, etc.) is blurred rather than legible. On Android
 * the same overlay shows but the platform's recents thumbnail still
 * captures the underlying view milliseconds before the pause fires.
 *
 * A2-1207: this helper was previously called `enableScreenshotGuard`,
 * which oversold what it actually does. Real screenshot prevention
 * needs `WindowManager.FLAG_SECURE` on Android (blocks both the
 * recents thumbnail and the screenshot button) and a
 * `UserDidTakeScreenshot` listener on iOS (no API to block the
 * shortcut, but you can detect + warn). The rename keeps this
 * codepath honest: it's a task-switcher privacy overlay, not a
 * screenshot guard.
 *
 * FE-01 (2026-07): Android `FLAG_SECURE` now ships — set app-wide in
 * `MainActivity.onCreate` (native-overlays/.../MainActivity.java), so
 * on Android the OS itself blocks screenshots / screen-recording and
 * renders the recents thumbnail blank. This JS overlay is therefore
 * belt-and-braces on Android and the *primary* app-switcher privacy
 * control on iOS, which has no FLAG_SECURE equivalent (screenshot
 * blocking is impossible there; only after-the-fact detection). The
 * iOS `UserDidTakeScreenshot` detect-and-warn listener remains
 * unshipped — see ADR-027 for the deferred native-plugin decisions.
 *
 * Returns a cleanup function.
 */
export function enableTaskSwitcherPrivacyOverlay(): () => void {
  if (!Capacitor.isNativePlatform()) return () => {};

  let overlay: HTMLDivElement | null = null;

  const onPause = (): void => {
    // Guard against repeat pause events — on some platforms the `pause`
    // listener can fire more than once before a matching `resume`, which
    // previously leaked stacked overlays (the first reference was lost when
    // we reassigned `overlay`).
    if (overlay !== null) return;
    overlay = document.createElement('div');
    overlay.id = 'privacy-overlay';
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:99999;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);background:rgba(0,0,0,0.3);';
    document.body.appendChild(overlay);
  };

  const onResume = (): void => {
    overlay?.remove();
    overlay = null;
  };

  document.addEventListener('pause', onPause);
  document.addEventListener('resume', onResume);

  return () => {
    document.removeEventListener('pause', onPause);
    document.removeEventListener('resume', onResume);
    overlay?.remove();
  };
}
