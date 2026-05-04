// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import React from 'react';

const { platformMock } = vi.hoisted(() => ({
  platformMock: {
    getPlatform: vi.fn<() => 'web' | 'ios' | 'android'>(() => 'web'),
    isNativePlatform: vi.fn<() => boolean>(() => false),
  },
}));

vi.mock('~/native/platform', () => ({
  getPlatform: () => platformMock.getPlatform(),
  isNativePlatform: () => platformMock.isNativePlatform(),
}));

import { useNativePlatform } from '../use-native-platform';

afterEach(cleanup);

function Probe(): React.ReactElement {
  const { platform, isNative } = useNativePlatform();
  return (
    <div>
      <span data-testid="platform">{platform}</span>
      <span data-testid="native">{String(isNative)}</span>
    </div>
  );
}

describe('useNativePlatform', () => {
  it('flips to ios/native=true after the post-mount effect runs', async () => {
    platformMock.getPlatform.mockReturnValue('ios');
    platformMock.isNativePlatform.mockReturnValue(true);
    render(<Probe />);
    // Effect runs after first render commit — the synchronous
    // initial state of web/false is the SSR-safety contract; this
    // assertion pins the post-effect flip to the native platform.
    await waitFor(() => expect(screen.getByTestId('platform').textContent).toBe('ios'));
    expect(screen.getByTestId('native').textContent).toBe('true');
  });

  it('flips to android/native=true after the effect', async () => {
    platformMock.getPlatform.mockReturnValue('android');
    platformMock.isNativePlatform.mockReturnValue(true);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('platform').textContent).toBe('android'));
    expect(screen.getByTestId('native').textContent).toBe('true');
  });

  it('stays web/false when getPlatform reports web', async () => {
    platformMock.getPlatform.mockReturnValue('web');
    platformMock.isNativePlatform.mockReturnValue(false);
    render(<Probe />);
    await waitFor(() => expect(platformMock.getPlatform).toHaveBeenCalled());
    expect(screen.getByTestId('platform').textContent).toBe('web');
    expect(screen.getByTestId('native').textContent).toBe('false');
  });
});
