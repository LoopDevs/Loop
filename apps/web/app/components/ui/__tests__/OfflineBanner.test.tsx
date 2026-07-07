// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

const { net } = vi.hoisted(() => ({
  net: { cb: null as ((connected: boolean) => void) | null, cleanup: vi.fn() },
}));

vi.mock('~/native/network', () => ({
  watchNetwork: (cb: (connected: boolean) => void) => {
    net.cb = cb;
    return net.cleanup;
  },
}));

import { OfflineBanner } from '../OfflineBanner';

afterEach(cleanup);
beforeEach(() => {
  net.cb = null;
  net.cleanup = vi.fn();
});

describe('OfflineBanner', () => {
  it('renders nothing while online', () => {
    render(<OfflineBanner />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows an alert banner when the network goes offline', () => {
    render(<OfflineBanner />);
    act(() => net.cb?.(false));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('No internet connection');
  });

  it('hides the banner again when the network reconnects', () => {
    render(<OfflineBanner />);
    act(() => net.cb?.(false));
    expect(screen.queryByRole('alert')).not.toBeNull();
    act(() => net.cb?.(true));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('subscribes on mount and cleans up on unmount', () => {
    const { unmount } = render(<OfflineBanner />);
    expect(net.cb).toBeTypeOf('function');
    expect(net.cleanup).not.toHaveBeenCalled();
    unmount();
    expect(net.cleanup).toHaveBeenCalledTimes(1);
  });
});
