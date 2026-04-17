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
    const current = get().theme;
    const next = current === 'light' ? 'dark' : 'light';
    get().setThemePreference(next);
  },

  addToast: (message, type = 'info') => {
    const id = `${Date.now()}-${Math.random()}`;
    set((s) => {
      const next = [...s.toasts, { id, message, type }];
      return { toasts: next.length > MAX_TOASTS ? next.slice(-MAX_TOASTS) : next };
    });
    setTimeout(() => get().removeToast(id), 5000);
  },

  removeToast: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));
