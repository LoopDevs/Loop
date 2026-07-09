// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  removeMock: vi.fn(async () => undefined),
  addListenerMock: vi.fn(async (_event: string, _handler: (data: { isActive: boolean }) => void) =>
    Promise.resolve({ remove: state.removeMock }),
  ),
  setFocusedMock: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
  },
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: state.addListenerMock,
  },
}));

vi.mock('@tanstack/react-query', () => ({
  focusManager: {
    setFocused: state.setFocusedMock,
  },
}));

import { registerAppStateSync } from '../app-state';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

describe('registerAppStateSync (native)', () => {
  it('registers an appStateChange listener and forwards isActive to focusManager', async () => {
    registerAppStateSync();
    await flushMicrotasks();

    expect(state.addListenerMock).toHaveBeenCalledWith('appStateChange', expect.any(Function));
    const handler = state.addListenerMock.mock.calls[0]?.[1] as (data: {
      isActive: boolean;
    }) => void;

    handler({ isActive: false });
    expect(state.setFocusedMock).toHaveBeenLastCalledWith(false);

    handler({ isActive: true });
    expect(state.setFocusedMock).toHaveBeenLastCalledWith(true);
  });

  it('disposer removes the listener', async () => {
    const dispose = registerAppStateSync();
    await flushMicrotasks();

    dispose();
    expect(state.removeMock).toHaveBeenCalled();
  });
});
