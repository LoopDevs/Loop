/**
 * UI store — theme preference + toast stack.
 *
 * A2-1161: SSR-safety contract, written down so the rules aren't
 * tribal knowledge. This module is imported at the root of the
 * React Router v7 SSR build (`root.tsx`), so it runs on the
 * server before hydration. Three things must stay true for every
 * invocation of this file at module-import time:
 *
 *   1. `loadPreference()` must not throw when `localStorage` is
 *      undefined. It wraps the `localStorage.getItem` in a try
 *      block and falls back to `'system'`.
 *   2. `resolveTheme()` must not throw when `window` is undefined.
 *      It guards the `matchMedia` call with `typeof window` and
 *      falls back to `'light'`.
 *   3. `applyTheme()` must not throw when `document` is undefined.
 *      It guards the classList mutation with `typeof document`
 *      and silently no-ops. The real application lives in a
 *      `useEffect` inside components that hydrate on the client.
 *
 * Any new top-level DOM access here needs the same pattern —
 * otherwise a bare `document.documentElement...` at module scope
 * crashes the SSR build. The `ui.store.ssr-safe.test.ts` test
 * pins this contract by importing the module in a fresh context
 * with no DOM globals and asserting it loads without throwing.
 */
import { create } from 'zustand';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface UiState {
  themePreference: ThemePreference;
  theme: ResolvedTheme;
  toasts: Toast[];
}

interface UiActions {
  setThemePreference: (pref: ThemePreference) => void;
  toggleTheme: () => void;
  addToast: (message: string, type?: Toast['type']) => void;
  removeToast: (id: string) => void;
}

function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref === 'system') {
    return typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  return pref;
}

function applyTheme(theme: ResolvedTheme): void {
  // SSR guard — `document` is undefined during server-render. `useEffect`
  // in consuming components re-runs the theme application on hydration,
  // so silently skipping here is correct.
  if (typeof document === 'undefined') return;
  document.documentElement.classList.remove('light', 'dark');
  document.documentElement.classList.add(theme);
}

function loadPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem('theme');
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // localStorage unavailable
  }
  return 'system';
}

function savePreference(pref: ThemePreference): void {
  try {
    localStorage.setItem('theme', pref);
  } catch {
    // localStorage unavailable
  }
}

const initialPref = loadPreference();

// Cap the toast stack. If something misbehaves and spams addToast (e.g. a
// failing action inside a tight poll), an uncapped array would paint a
// wall of duplicates and keep growing. Drop the oldest when full.
const MAX_TOASTS = 5;

// Track auto-dismiss timers so removeToast can cancel the pending
// setTimeout. Previously a user-dismissed toast still fired its 5s timer,
// attempting to remove a now-absent id. Harmless but wasteful, and if the
// map-cap evicted a toast before its timer, the timer ran forever as a
// no-op leak.
const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const useUiStore = create<UiState & UiActions>((set, get) => ({
  themePreference: initialPref,
  theme: resolveTheme(initialPref),
  toasts: [],

  setThemePreference: (pref) => {
    const theme = resolveTheme(pref);
    applyTheme(theme);
    savePreference(pref);
    set({ themePreference: pref, theme });
  },

  toggleTheme: () => {
    // Read the actual html.dark class as source of truth rather than
    // the store's `theme` state — if the inline theme script in
    // root.tsx resolved the initial theme differently from the
    // store's own loadPreference (e.g. a localStorage hiccup, a
    // race during hydration), the two can disagree on first load,
    // and a store-only toggle would re-assert what's already on the
    // class, resulting in a "first click does nothing" UX. Reading
    // the class is always in sync with what the user actually sees.
    const hasDarkClass =
      typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
    const next: ResolvedTheme = hasDarkClass ? 'light' : 'dark';
    get().setThemePreference(next);
  },

  addToast: (message, type = 'info') => {
    const id = `${Date.now()}-${Math.random()}`;
    set((s) => {
      const next = [...s.toasts, { id, message, type }];
      if (next.length > MAX_TOASTS) {
        // When we drop the oldest, also cancel its dismiss timer so we
        // don't later fire a removeToast for an id that no longer exists.
        const dropped = next.slice(0, next.length - MAX_TOASTS);
        for (const d of dropped) {
          const t = toastTimers.get(d.id);
          if (t !== undefined) {
            clearTimeout(t);
            toastTimers.delete(d.id);
          }
        }
        return { toasts: next.slice(-MAX_TOASTS) };
      }
      return { toasts: next };
    });
    toastTimers.set(
      id,
      setTimeout(() => get().removeToast(id), 5000),
    );
  },

  removeToast: (id) => {
    const t = toastTimers.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      toastTimers.delete(id);
    }
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));
