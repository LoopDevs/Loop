// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * FE-22 — crawler/runtime gate parity.
 *
 * The gate decision is resolved by `useAppConfig`, which only fetches
 * `/api/config` after hydration. So SSR — the HTML a crawler indexes —
 * always renders with the fallback, never the backend's live value. This
 * test drives the REAL `useAppConfig` (config service mocked to stay
 * pending, i.e. the SSR / first-paint state) to prove the fallback is now
 * deploy-aware: a Phase-2 deployment (`VITE_PHASE_1_ONLY=false`) renders
 * the live page even in the pre-config state a crawler sees, instead of
 * the "Coming soon" gate a runtime would then flip away from.
 */

const { fetchAppConfigMock } = vi.hoisted(() => ({ fetchAppConfigMock: vi.fn() }));
vi.mock('~/services/config', () => ({
  // Never resolves — pins the SSR / first-paint state where the query is
  // still pending and the deploy-aware fallback is what renders.
  fetchAppConfig: () => fetchAppConfigMock(),
}));

import { Phase2Gate } from '../Phase2Gate';

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  fetchAppConfigMock.mockReset();
  fetchAppConfigMock.mockReturnValue(new Promise(() => {}));
});

function renderGate(): void {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/gb/en/cashback']}>
        <Routes>
          <Route
            path=":country/:lang/*"
            element={
              <Phase2Gate>
                <div>live cashback page</div>
              </Phase2Gate>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Phase2Gate crawler/runtime parity (FE-22)', () => {
  it('renders the live page in the SSR/first-paint state on a Phase-2 deployment', () => {
    vi.stubEnv('VITE_PHASE_1_ONLY', 'false');
    renderGate();
    expect(screen.getByText('live cashback page')).toBeTruthy();
    expect(screen.queryByText('Coming soon')).toBeNull();
  });

  it('still shows "Coming soon" in the SSR/first-paint state when the flag is unset (Phase-1)', () => {
    vi.stubEnv('VITE_PHASE_1_ONLY', undefined as unknown as string);
    renderGate();
    expect(screen.getByText('Coming soon')).toBeTruthy();
    expect(screen.queryByText('live cashback page')).toBeNull();
  });
});
