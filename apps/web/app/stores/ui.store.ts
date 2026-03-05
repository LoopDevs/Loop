import { create } from 'zustand';

type Theme = 'light' | 'dark';

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface UiState {
  theme: Theme;
  toasts: Toast[];
}

interface UiActions {
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  addToast: (message: string, type?: Toast['type']) => void;
  removeToast: (id: string) => void;
}

export const useUiStore = create<UiState & UiActions>((set, get) => ({
  theme: 'light',
  toasts: [],

  setTheme: (theme) => {
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.classList.add(theme);
    try {
      localStorage.setItem('theme', theme);
    } catch {
      // sessionStorage unavailable in some embedded contexts
    }
    set({ theme });
  },

  toggleTheme: () => {
    get().setTheme(get().theme === 'light' ? 'dark' : 'light');
  },

  addToast: (message, type = 'info') => {
    const id = `${Date.now()}-${Math.random()}`;
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }));
    setTimeout(() => get().removeToast(id), 5000);
  },

  removeToast: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));
