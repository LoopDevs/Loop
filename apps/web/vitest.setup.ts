/**
 * Global vitest setup (ADR 043 / B-6).
 *
 * Every test file gets its own module registry (vitest's default file
 * isolation), so a component that calls `useTranslation()` needs the
 * i18next singleton initialized *within that file's registry* before it
 * renders — importing `~/i18n/i18next` from application code elsewhere in
 * the same file's import graph is NOT guaranteed to run before the test
 * body, and relying on every test file to remember this import is exactly
 * the kind of thing that silently rots (a component starts calling `t()`,
 * its test starts asserting rendered strings, and without this the
 * assertion would see raw `"namespace:key"` strings instead of English
 * copy — see the `onboarding-phase1-copy.test.tsx` / `onboarding-skip-nav.test.tsx`
 * regression this setup file fixes).
 *
 * Importing for the side effect is enough: `~/i18n/i18next` calls
 * `i18next.use(initReactI18next).init(...)` synchronously with bundled
 * resources, so by the time this module finishes evaluating,
 * `i18n.isInitialized` is true and every subsequent `useTranslation()` in
 * this test file resolves real English copy — with no explicit
 * `<I18nextProvider>` wrapper required per test (react-i18next falls back
 * to the singleton `initReactI18next` registered), matching how `root.tsx`
 * wires the app in production.
 */
import '~/i18n/i18next';
