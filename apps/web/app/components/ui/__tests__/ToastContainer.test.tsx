// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

// ui.store resolves the initial theme via window.matchMedia at module
// import time — jsdom doesn't implement it, so stub it before any import
// pulls the store in (vi.hoisted runs pre-import). Mirrors the admin
// panel tests' convention.
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
});

import { useUiStore } from '~/stores/ui.store';
import { ToastContainer } from '../ToastContainer';

afterEach(() => {
  cleanup();
  act(() => {
    useUiStore.setState({ toasts: [] });
  });
});

describe('ToastContainer dismiss button', () => {
  it('meets the WCAG 2.5.8 24x24 minimum target size', () => {
    act(() => {
      useUiStore.setState({ toasts: [{ id: 't1', message: 'Saved', type: 'success' }] });
    });
    render(<ToastContainer />);

    const btn = screen.getByRole('button', { name: 'Dismiss' });
    // jsdom has no layout engine (getBoundingClientRect is 0x0), so we
    // assert the Tailwind min-target classes that enforce >=24x24 CSS px.
    expect(btn.className).toContain('min-h-[24px]');
    expect(btn.className).toContain('min-w-[24px]');
  });
});
