// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  removeMock: vi.fn(async () => undefined),
  addListenerMock: vi.fn(async (_event: string, _handler: (data: { url: string }) => void) =>
    Promise.resolve({ remove: state.removeMock }),
  ),
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

import { registerDeepLinks } from '../deep-link';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

describe('registerDeepLinks (native)', () => {
  it('registers an appUrlOpen listener and navigates on a trusted https link', async () => {
    const onNavigate = vi.fn();
    registerDeepLinks(onNavigate);
    await flushMicrotasks();

    expect(state.addListenerMock).toHaveBeenCalledWith('appUrlOpen', expect.any(Function));
    const handler = state.addListenerMock.mock.calls[0]?.[1] as (data: { url: string }) => void;

    handler({ url: 'https://loopfinance.io/gift-card/starbucks' });
    expect(onNavigate).toHaveBeenCalledWith('/gift-card/starbucks');
  });

  it('does not navigate for an untrusted host or scheme', async () => {
    const onNavigate = vi.fn();
    registerDeepLinks(onNavigate);
    await flushMicrotasks();

    const handler = state.addListenerMock.mock.calls[0]?.[1] as (data: { url: string }) => void;

    handler({ url: 'https://evil.example.com/gift-card/starbucks' });
    handler({ url: 'javascript:alert(1)' });
    handler({ url: 'loopfinance://gift-card/starbucks' });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('disposer removes the listener', async () => {
    const dispose = registerDeepLinks(vi.fn());
    await flushMicrotasks();

    dispose();
    expect(state.removeMock).toHaveBeenCalled();
  });
});
