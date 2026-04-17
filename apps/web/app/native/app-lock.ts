import { Capacitor } from '@capacitor/core';
import { checkBiometrics, authenticateWithBiometrics } from './biometrics';

const APP_LOCK_KEY = 'loop_app_lock_enabled';

/** Checks if app lock is enabled in user preferences. */
export async function isAppLockEnabled(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const { Preferences } = await import('@capacitor/preferences');
    const { value } = await Preferences.get({ key: APP_LOCK_KEY });
    return value === 'true';
  } catch {
    return false;
  }
}

/** Enables or disables app lock. */
export async function setAppLockEnabled(enabled: boolean): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const { Preferences } = await import('@capacitor/preferences');
  await Preferences.set({ key: APP_LOCK_KEY, value: String(enabled) });
}

/**
 * Prompts for biometrics once on cold start when app-lock is enabled.
 * Returns a cleanup function.
 *
 * Design choice: we intentionally do NOT re-prompt on resume. A Loop gift
 * card can only be bought by paying XLM from the user's own wallet, so a
 * phone thief in possession of an unlocked handset still can't make a
 * fraudulent purchase. Re-authenticating on every brief context switch
 * (pulling down notifications, reading an SMS, switching apps for five
 * seconds) makes the app feel hostile for no real security benefit. The
 * cold-start prompt catches the "someone found/stole a locked phone and
 * managed to get it unlocked" case; anything more is theatre.
 */
export function registerAppLockGuard(): () => void {
  if (!Capacitor.isNativePlatform()) return () => {};

  let overlay: HTMLDivElement | null = null;
  // Cancellation flag — the async check below kicks off at registration
  // time. If cleanup runs while it is still in-flight, its eventual
  // showLockScreen() would leak an overlay onto a page the caller has
  // already torn down. Flag every branch against `cancelled` before
  // mutating DOM.
  let cancelled = false;

  const showLockScreen = (): void => {
    if (cancelled) return;
    if (overlay) return;
    // Match the splash screen's look (background + logo) so the overlay
    // feels like a natural extension of the app's boot state rather than
    // a jarring security prompt. Theme follows the html.dark class set by
    // the inline theme script in root.tsx so it paints correctly on the
    // very first paint.
    const isDark = document.documentElement.classList.contains('dark');
    const bg = isDark ? 'rgb(3, 7, 18)' : 'rgb(249, 250, 251)';
    const fg = isDark ? 'rgba(255, 255, 255, 0.55)' : 'rgba(17, 24, 39, 0.55)';
    const logo = isDark ? '/loop-logo-white.svg' : '/loop-logo.svg';
    overlay = document.createElement('div');
    overlay.id = 'app-lock-overlay';
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:99998',
      `background:${bg}`,
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'flex-direction:column',
      'gap:1.25rem',
      'opacity:1',
      'transition:opacity 200ms ease-out',
      'cursor:pointer',
    ].join(';');
    overlay.innerHTML = `
      <img src="${logo}" alt="Loop" style="height:2.5rem" />
      <div style="color:${fg};font-size:0.875rem;letter-spacing:0.01em;">Unlock to continue</div>
    `;
    overlay.addEventListener('click', () => {
      void attemptUnlock();
    });
    document.body.appendChild(overlay);
  };

  const hideLockScreen = (): void => {
    if (!overlay) return;
    // Fade out so the content reveal feels intentional, not a flicker.
    // Detach a local reference because the class-level `overlay` gets
    // nulled immediately — otherwise a rapid re-show could race against
    // the scheduled removal and drop the new overlay instead of the old.
    const el = overlay;
    el.style.opacity = '0';
    overlay = null;
    window.setTimeout(() => el.remove(), 200);
  };

  const attemptUnlock = async (): Promise<void> => {
    const ok = await authenticateWithBiometrics('Unlock Loop');
    if (!cancelled && ok) hideLockScreen();
  };

  const runLockCheck = async (): Promise<void> => {
    const enabled = await isAppLockEnabled();
    if (cancelled || !enabled) return;
    const { available } = await checkBiometrics();
    if (cancelled || !available) return;
    showLockScreen();
    void attemptUnlock();
  };

  // Cold-start check only — no resume listener (see function docstring).
  void runLockCheck();

  return () => {
    cancelled = true;
    hideLockScreen();
  };
}
