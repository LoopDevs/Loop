import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A2-1161: pins the SSR-safety contract documented in the
 * `ui.store.ts` header. The store is imported at module scope by
 * `apps/web/app/root.tsx`, so it runs on every SSR render — BEFORE
 * any hydration has set up `window` / `document` / `localStorage`.
 *
 * A naive `const stored = localStorage.getItem(...)` at module scope
 * would throw `ReferenceError: localStorage is not defined` during
 * the Node SSR pass and take down every route that imports this
 * module transitively. This test is the tripwire for that class of
 * regression: import the module in a fresh Vitest context with
 * *no* DOM globals installed, and assert the import itself doesn't
 * throw.
 *
 * The sibling `ui.store.test.ts` exercises the store's runtime
 * behaviour against stubbed DOM globals; this file exercises the
 * bootstrapping path where the globals genuinely don't exist.
 */
describe('ui.store — SSR safety (A2-1161)', () => {
  beforeEach(() => {
    // Reset the module registry so `import('../ui.store')` below
    // runs `loadPreference()` / `resolveTheme()` afresh each case.
    vi.resetModules();
    // Wipe any DOM globals a prior test might have stubbed.
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('imports cleanly with no window / document / localStorage', async () => {
    // Belt-and-braces: the test's own runtime is `node` (see
    // `apps/web/vitest.config.ts`), so these globals already aren't
    // set by jsdom. But a prior test in the same worker could have
    // stubbed them. Explicitly nullify via stubGlobal so the fresh
    // import sees the canonical SSR shape.
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('localStorage', undefined);

    // The whole point: loading this module must not throw.
    const mod = await import('../ui.store');
    expect(typeof mod.useUiStore).toBe('function');

    // Store initial state must be sensible — `'system'` preference,
    // `'light'` resolved theme fallback (per resolveTheme's SSR branch).
    const state = mod.useUiStore.getState();
    expect(state.themePreference).toBe('system');
    expect(state.theme).toBe('light');
    expect(state.toasts).toEqual([]);
  });

  it('store action applyTheme no-ops when document is undefined', async () => {
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('localStorage', undefined);

    const mod = await import('../ui.store');
    // Call an action that hits `applyTheme` internally. The SSR
    // guard must swallow the `document === undefined` case silently
    // — any uncaught throw would propagate up through zustand and
    // crash the render tree.
    expect(() => mod.useUiStore.getState().setThemePreference('dark')).not.toThrow();
    // State did still update — only the DOM side effect was skipped.
    expect(mod.useUiStore.getState().themePreference).toBe('dark');
    expect(mod.useUiStore.getState().theme).toBe('dark');
  });
});
