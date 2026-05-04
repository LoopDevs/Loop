/**
 * Inline theme-init script + its CSP hash (A4-057).
 *
 * The theme-init runs before React hydrates so the dark/light class is
 * on `<html>` immediately on first paint — without it the page flashes
 * white-then-dark on a dark-mode user's first load (FOUC). Stays
 * inline because by the time React renders, hydration has already
 * happened; an external script would defeat the point.
 *
 * `THEME_INIT_SCRIPT_HASH` is the literal CSP token — `'sha256-…'`
 * — that authorises this exact script body. Changing the script
 * body invalidates the hash; the unit test in
 * `__tests__/theme-init-script.test.ts` recomputes it on every run
 * so a forgotten update fails CI rather than silently breaking CSP.
 *
 * Hash workflow when editing the script:
 *
 *   ```
 *   node -e "console.log('sha256-' + require('crypto')
 *     .createHash('sha256')
 *     .update(require('./apps/web/app/utils/theme-init-script').THEME_INIT_SCRIPT)
 *     .digest('base64'))"
 *   ```
 *
 * Update `THEME_INIT_SCRIPT_HASH` to the printed value, then re-run
 * the test suite.
 */

/**
 * Theme-init script body. Pre-React inline guard against FOUC.
 *
 * Reads the saved theme preference, falls back to `prefers-color-scheme`,
 * then sets `dark` or `light` on `<html>` so Tailwind's class-based
 * dark mode applies before the first paint.
 *
 * Whitespace is exact — the CSP hash below is computed against this
 * literal byte sequence.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('theme');var d=window.matchMedia('(prefers-color-scheme: dark)').matches;var isDark=(t==='dark')||(t!=='light'&&d);document.documentElement.classList.add(isDark?'dark':'light');}catch(e){document.documentElement.classList.add('light');}})();`;

/**
 * CSP `script-src` token for the script above. A4-057 replaces the
 * blanket `'unsafe-inline'` with this single hash so any other inline
 * script — accidentally introduced or attacker-injected via XSS — is
 * blocked by the browser's CSP enforcement.
 */
export const THEME_INIT_SCRIPT_HASH = "'sha256-pfhzWN3ADcCNUGkGrGxyduwXj4RZsjjSW4q49o3CZCk='";
