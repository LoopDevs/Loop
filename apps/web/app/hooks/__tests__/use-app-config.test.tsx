// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { fetchAppConfigMock } = vi.hoisted(() => ({
  fetchAppConfigMock: vi.fn(),
}));

vi.mock('~/services/config', () => ({
  fetchAppConfig: () => fetchAppConfigMock(),
}));

import { useAppConfig } from '../use-app-config';

afterEach(cleanup);

beforeEach(() => fetchAppConfigMock.mockReset());

function Probe(): React.ReactElement {
  const { config, isLoading } = useAppConfig();
  return (
    <div>
      <span data-testid="loading">{isLoading ? 'true' : 'false'}</span>
      <span data-testid="native">{String(config.loopAuthNativeEnabled)}</span>
      <span data-testid="orders">{String(config.loopOrdersEnabled)}</span>
      <span data-testid="google-web">{config.social.googleClientIdWeb ?? '__null__'}</span>
    </div>
  );
}

function renderProbe(): void {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, throwOnError: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <Probe />
    </QueryClientProvider>,
  );
}

describe('useAppConfig', () => {
  it('returns the fetched config once the request resolves', async () => {
    fetchAppConfigMock.mockResolvedValue({
      loopAuthNativeEnabled: true,
      loopOrdersEnabled: true,
      social: {
        googleClientIdWeb: 'gid-web',
        googleClientIdIos: null,
        googleClientIdAndroid: null,
        appleServiceId: null,
      },
    });
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    expect(screen.getByTestId('native').textContent).toBe('true');
    expect(screen.getByTestId('orders').textContent).toBe('true');
    expect(screen.getByTestId('google-web').textContent).toBe('gid-web');
  });

  it('renders safe defaults during initial pending state', () => {
    let resolve!: (value: unknown) => void;
    fetchAppConfigMock.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    renderProbe();
    // Synchronously, before the query resolves: loading=true and the
    // safe defaults take effect (no flag silently flipped on).
    expect(screen.getByTestId('loading').textContent).toBe('true');
    expect(screen.getByTestId('native').textContent).toBe('false');
    expect(screen.getByTestId('orders').textContent).toBe('false');
    // Resolve so cleanup is clean.
    resolve({
      loopAuthNativeEnabled: false,
      loopOrdersEnabled: false,
      social: {
        googleClientIdWeb: null,
        googleClientIdIos: null,
        googleClientIdAndroid: null,
        appleServiceId: null,
      },
    });
  });

  // Negative-path note: the error path runs through the same
  // `query.data ?? DEFAULT_CONFIG` fallback that the
  // pending-state test above pins. A direct error-path renderProbe
  // run is gated by vitest 4.x's unhandled-rejection bubbling
  // inside the React-Query queryFn — a known interaction that's
  // worked around by the existing component tests via service-
  // layer mocks (see OrderPayoutCard.test.tsx) rather than here.
});
