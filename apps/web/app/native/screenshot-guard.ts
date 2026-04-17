import { Capacitor } from '@capacitor/core';

/**
 * Prevents screenshots on sensitive screens.
 * On iOS, blurs the view when app is backgrounded (task switcher).
 * On Android, this is a best-effort overlay — true FLAG_SECURE requires a native plugin.
 * Returns a cleanup function.
 */
export function enableScreenshotGuard(): () => void {
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
