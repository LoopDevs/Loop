import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock DOM APIs before importing the store (it runs loadPreference at module init)
const mockClassList = {
  add: vi.fn(),
  remove: vi.fn(),
  contains: vi.fn(() => false),
};
vi.stubGlobal('document', {
  documentElement: { classList: mockClassList },
});
vi.stubGlobal('localStorage', {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
});
vi.stubGlobal('window', {
  matchMedia: vi.fn(() => ({ matches: false })),
});

import { useUiStore } from '../ui.store';

describe('ui store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to system theme preference', () => {
    expect(useUiStore.getState().themePreference).toBe('system');
  });

  it('setThemePreference updates preference and resolved theme', () => {
    useUiStore.getState().setThemePreference('dark');
    const state = useUiStore.getState();
    expect(state.themePreference).toBe('dark');
    expect(state.theme).toBe('dark');
  });

  it('setThemePreference saves to localStorage', () => {
    useUiStore.getState().setThemePreference('light');
    expect(localStorage.setItem).toHaveBeenCalledWith('theme', 'light');
  });

  it('setThemePreference applies theme to document', () => {
    useUiStore.getState().setThemePreference('dark');
    expect(mockClassList.remove).toHaveBeenCalledWith('light', 'dark');
    expect(mockClassList.add).toHaveBeenCalledWith('dark');
  });

  it('toggleTheme switches between light and dark', () => {
    useUiStore.getState().setThemePreference('light');
    useUiStore.getState().toggleTheme();
    expect(useUiStore.getState().theme).toBe('dark');
    useUiStore.getState().toggleTheme();
    expect(useUiStore.getState().theme).toBe('light');
  });

  it('addToast adds a toast with auto-generated id', () => {
    useUiStore.getState().addToast('Test message', 'success');
    const toasts = useUiStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.message).toBe('Test message');
    expect(toasts[0]!.type).toBe('success');
    expect(toasts[0]!.id).toBeDefined();
  });

  it('addToast defaults to info type', () => {
    useUiStore.getState().addToast('Info toast');
    const toasts = useUiStore.getState().toasts;
    const infoToast = toasts.find((t) => t.message === 'Info toast');
    expect(infoToast).toBeDefined();
    expect(infoToast!.type).toBe('info');
  });

  it('removeToast removes by id', () => {
    // Clear existing toasts first
    for (const toast of useUiStore.getState().toasts) {
      useUiStore.getState().removeToast(toast.id);
    }
    useUiStore.getState().addToast('Test', 'info');
    const id = useUiStore.getState().toasts[0]!.id;
    useUiStore.getState().removeToast(id);
    expect(useUiStore.getState().toasts).toHaveLength(0);
  });

  it('removeToast is a no-op for non-existent id', () => {
    const before = useUiStore.getState().toasts.length;
    useUiStore.getState().removeToast('nonexistent-id');
    expect(useUiStore.getState().toasts).toHaveLength(before);
  });
});
