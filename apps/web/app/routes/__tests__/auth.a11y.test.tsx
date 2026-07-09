// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

/**
 * ADR 042 (B-2): runtime DOM a11y smoke test for the /auth sign-in screen
 * (the highest-traffic auth surface). Mocking mirrors
 * routes/__tests__/auth.account-balance.test.tsx's established pattern,
 * rendering the signed-out email-entry form.
 */

expect.extend(toHaveNoViolations);

afterEach(cleanup);

const { authMock } = vi.hoisted(() => ({
  authMock: { isAuthenticated: false },
}));

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({
    isAuthenticated: authMock.isAuthenticated,
    email: null,
    requestOtp: vi.fn(),
    verifyOtp: vi.fn(),
    signInWithGoogle: vi.fn(),
    signInWithApple: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock('~/hooks/use-wallet', () => ({
  WALLET_QUERY_KEY: ['me', 'wallet'],
  useWallet: () => ({
    wallet: undefined,
    isActivated: false,
    balanceFor: () => '0',
    isLoading: false,
    isError: false,
  }),
}));

vi.mock('~/hooks/use-native-platform', () => ({
  useNativePlatform: () => ({ isNative: false, platform: 'web' }),
}));

// Signed-out render never mounts the social buttons unless a client ID is
// configured — leave them unconfigured so the form is just email + OTP.
vi.mock('~/hooks/use-app-config', () => ({
  useAppConfig: () => ({
    config: {
      phase1Only: true,
      social: {
        googleClientIdWeb: null,
        googleClientIdIos: null,
        googleClientIdAndroid: null,
        appleServiceId: null,
      },
    },
    isLoading: false,
  }),
}));

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

// jsdom has no matchMedia; the theme store resolves it at module init.
vi.mock('~/stores/ui.store', () => ({
  useUiStore: () => ({ themePreference: 'system', setThemePreference: vi.fn() }),
}));

import AuthRoute from '../auth';

function renderAuth(): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AuthRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<AuthRoute /> a11y', () => {
  it('has no axe violations at WCAG 2.1 A/AA on the signed-out email-entry form', async () => {
    const { container } = renderAuth();
    await waitFor(() => {
      expect(screen.getByLabelText(/email address/i)).toBeDefined();
    });
    const results = await axe(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    expect(results).toHaveNoViolations();
  });
});
