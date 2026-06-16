/**
 * A2-1521: shared locale constant for admin / ops views.
 *
 * Admin / ops views are locale-stable across the ops team — a support
 * ticket saying "£2,500.00 on 23 Apr 2026" should mean the same thing
 * whether it's opened by a US-locale or UK-locale operator. Locked to
 * en-US so every operator sees identical output. Centralising the value
 * here lets us change the default in one place if we ever run an
 * international ops team.
 *
 * The former `USER_LOCALE` (browser-locale escape hatch) was removed
 * under the cold-audit CF-22 finding: it was imported by nobody and its
 * `navigator.language` intent contradicted ADR 034's route-driven locale
 * model. User-facing surfaces derive their locale from the active route
 * via `i18n/format.ts#useLocaleTag`, not the browser.
 */

/** Stable en-US — use in admin views so ops sees consistent output. */
export const ADMIN_LOCALE = 'en-US';
