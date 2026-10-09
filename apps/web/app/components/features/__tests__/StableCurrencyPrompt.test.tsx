// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '~/i18n/i18next';
import { useAuthStore } from '~/stores/auth.store';

const meState = vi.hoisted(() => ({ country: null as string | null, homeCurrency: 'USD' }));
vi.mock('~/services/user', () => ({
  getMe: async () => ({ country: meState.country, homeCurrency: meState.homeCurrency }),
}));

import { StableCurrencyPrompt } from '../StableCurrencyPrompt';

beforeEach(() => {
  const proto = HTMLDialogElement.prototype as unknown as {
    showModal?: () => void;
    close?: () => void;
  };
  if (typeof proto.showModal !== 'function') {
    proto.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  }
  if (typeof proto.close !== 'function') {
    proto.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  }
  useAuthStore.setState({ stableCurrencyPromptPending: false });
  meState.country = null;
  meState.homeCurrency = 'USD';
});
afterEach(cleanup);

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderPrompt(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/gb/en']}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <StableCurrencyPrompt />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const dialog = (): HTMLDialogElement | null => document.querySelector('dialog');

describe('<StableCurrencyPrompt />', () => {
  it('stays closed until a sign-in creates the account', () => {
    renderPrompt();
    expect(dialog()?.hasAttribute('open')).toBe(false);
  });

  it('shows the country and the stable CTX selected for it', async () => {
    meState.country = 'GB';
    meState.homeCurrency = 'GBP';
    useAuthStore.setState({ stableCurrencyPromptPending: true });
    renderPrompt();
    await waitFor(() => expect(dialog()?.hasAttribute('open')).toBe(true));
    expect(
      screen.getByText(
        /set up for 🇬🇧 United Kingdom, so your cashback will be held in GBPLOOP \(GBP\)/,
      ),
    ).toBeDefined();
  });

  it('falls back to the currency alone when the account has no country', async () => {
    useAuthStore.setState({ stableCurrencyPromptPending: true });
    renderPrompt();
    await waitFor(() => expect(dialog()?.hasAttribute('open')).toBe(true));
    expect(screen.getByText(/Your cashback will be held in USDC \(USD\)/)).toBeDefined();
  });

  it('Confirm closes the prompt and clears the pending flag', async () => {
    useAuthStore.setState({ stableCurrencyPromptPending: true });
    renderPrompt();
    await waitFor(() => expect(dialog()?.hasAttribute('open')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(useAuthStore.getState().stableCurrencyPromptPending).toBe(false);
    expect(dialog()?.hasAttribute('open')).toBe(false);
  });

  it('Settings navigates to the wallet settings page', async () => {
    useAuthStore.setState({ stableCurrencyPromptPending: true });
    renderPrompt();
    await waitFor(() => expect(dialog()?.hasAttribute('open')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByTestId('location').textContent).toBe('/settings/wallet');
    expect(useAuthStore.getState().stableCurrencyPromptPending).toBe(false);
  });
});
