// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import React from 'react';

const { net } = vi.hoisted(() => ({
  net: { cb: null as ((connected: boolean) => void) | null, cleanup: vi.fn() },
}));

vi.mock('~/native/network', () => ({
  watchNetwork: (cb: (connected: boolean) => void) => {
    net.cb = cb;
    return net.cleanup;
  },
}));

import { useOnline } from '../use-online';

afterEach(cleanup);
beforeEach(() => {
  net.cb = null;
  net.cleanup = vi.fn();
});

function Probe(): React.ReactElement {
  const online = useOnline();
  return <span data-testid="online">{String(online)}</span>;
}

describe('useOnline', () => {
  it('reports online on first render (SSR-safe default)', () => {
    render(<Probe />);
    expect(screen.getByTestId('online').textContent).toBe('true');
  });

  it('flips to false when the network drops and back to true on reconnect', () => {
    render(<Probe />);
    act(() => net.cb?.(false));
    expect(screen.getByTestId('online').textContent).toBe('false');
    act(() => net.cb?.(true));
    expect(screen.getByTestId('online').textContent).toBe('true');
  });

  it('subscribes on mount and unsubscribes on unmount', () => {
    const { unmount } = render(<Probe />);
    expect(net.cb).toBeTypeOf('function');
    expect(net.cleanup).not.toHaveBeenCalled();
    unmount();
    expect(net.cleanup).toHaveBeenCalledTimes(1);
  });
});
