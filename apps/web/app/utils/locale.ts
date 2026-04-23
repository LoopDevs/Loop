/**
 * A2-1521: shared locale constants.
 *
 * Two axes of locale choice in the web app:
 *
 *   1. User-facing views (home, purchase flow, order status). These
 *      should respect the user's browser locale so dates + number
 *      separators feel native. `USER_LOCALE = undefined` — the Intl
 *      default that reads `navigator.language`.
 *
 *   2. Admin / ops views. These should be locale-stable across the
 *      ops team — a support ticket saying "£2,500.00 on 23 Apr
 *      2026" should mean the same thing whether it's opened by a
 *      US-locale or UK-locale operator. Locked to en-US so every
 *      operator sees identical output.
 *
 * The admin constant's VALUE is the same string that's already
 * hard-coded in 14 call sites; centralising it here lets us change
 * the default in one place if we ever run an international ops team.
 */

/** Browser default — use everywhere a user-facing value is rendered. */
export const USER_LOCALE: string | undefined = undefined;

/** Stable en-US — use in admin views so ops sees consistent output. */
export const ADMIN_LOCALE = 'en-US';
