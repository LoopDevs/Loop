// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '~/i18n/i18next';

const authState = vi.hoisted(() => ({ isAuthenticated: false, country: null as string | null }));
vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authState.isAuthenticated }),
}));
vi.mock('~/services/user', () => ({
  getMe: async () => ({ country: authState.country }),
}));

import { OutsideHomeCountryDialog } from '../OutsideHomeCountryDialog';

afterEach(() => {
  cleanup();
  authState.isAuthenticated = false;
  authState.country = null;
});

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
  document.cookie = 'loop_country=; path=/; max-age=0';
});

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return (
    <>
      <div data-testid="location">{location.pathname}</div>
      <Link to="/gb/en/gift-card/shop-gb?again=1">Revisit</Link>
    </>
  );
}

function renderAt(merchantCountry: string | undefined): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/gb/en/gift-card/shop-gb']}>
        <Routes>
          <Route
            path="/:country/:lang/*"
            element={
              <>
                <OutsideHomeCountryDialog merchantId="m-1" merchantCountry={merchantCountry} />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function dialog(): HTMLDialogElement | null {
  return document.querySelector('dialog');
}

describe('<OutsideHomeCountryDialog />', () => {
  it('opens when the merchant country differs from the saved country choice', () => {
    document.cookie = 'loop_country=pt; path=/';
    renderAt('GB');
    expect(dialog()?.hasAttribute('open')).toBe(true);
    expect(
      screen.getByText(
        /based in 🇬🇧 United Kingdom, but your home country is 🇵🇹 Portugal\. Purchases from this merchant can only be redeemed in United Kingdom\./,
      ),
    ).toBeDefined();
  });

  it('falls back to the country code for a merchant country that is not configured', () => {
    document.cookie = 'loop_country=us; path=/';
    renderAt('IQ');
    expect(
      screen.getByText(
        /based in IQ, but your home country is 🇺🇸 United States\. Purchases from this merchant can only be redeemed in IQ\./,
      ),
    ).toBeDefined();
  });

  it('stays closed when the merchant is in the saved country', () => {
    document.cookie = 'loop_country=gb; path=/';
    renderAt('GB');
    expect(dialog()?.hasAttribute('open')).toBe(false);
  });

  it('stays closed when no country choice has been saved', () => {
    renderAt('GB');
    expect(dialog()?.hasAttribute('open')).toBe(false);
  });

  it('stays closed when the merchant has no country', () => {
    document.cookie = 'loop_country=pt; path=/';
    renderAt(undefined);
    expect(dialog()?.hasAttribute('open')).toBe(false);
  });

  it('Continue closes the dialog and keeps the page', () => {
    document.cookie = 'loop_country=pt; path=/';
    renderAt('GB');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(dialog()?.hasAttribute('open')).toBe(false);
    expect(screen.getByTestId('location').textContent).toBe('/gb/en/gift-card/shop-gb');
  });

  it('Home navigates to the saved country home page', () => {
    document.cookie = 'loop_country=pt; path=/';
    renderAt('GB');
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(screen.getByTestId('location').textContent).toBe('/pt/en');
  });

  it('picks up a country choice saved after mount once the page navigates', () => {
    document.cookie = 'loop_country=gb; path=/';
    renderAt('GB');
    expect(dialog()?.hasAttribute('open')).toBe(false);
    document.cookie = 'loop_country=us; path=/';
    fireEvent.click(screen.getByRole('link', { name: 'Revisit' }));
    expect(dialog()?.hasAttribute('open')).toBe(true);
    expect(screen.getByText(/your home country is 🇺🇸 United States/)).toBeDefined();
  });

  it('re-opens after Continue when the home country changes', () => {
    document.cookie = 'loop_country=pt; path=/';
    renderAt('GB');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(dialog()?.hasAttribute('open')).toBe(false);
    document.cookie = 'loop_country=us; path=/';
    fireEvent.click(screen.getByRole('link', { name: 'Revisit' }));
    expect(dialog()?.hasAttribute('open')).toBe(true);
  });

  it("prefers the signed-in account's country over the cookie", async () => {
    document.cookie = 'loop_country=gb; path=/';
    authState.isAuthenticated = true;
    authState.country = 'US';
    renderAt('GB');
    await waitFor(() => expect(dialog()?.hasAttribute('open')).toBe(true));
    expect(screen.getByText(/your home country is 🇺🇸 United States/)).toBeDefined();
  });

  it('falls back to the cookie while the account has no country', async () => {
    document.cookie = 'loop_country=pt; path=/';
    authState.isAuthenticated = true;
    renderAt('GB');
    await waitFor(() => expect(dialog()?.hasAttribute('open')).toBe(true));
    expect(screen.getByText(/your home country is 🇵🇹 Portugal/)).toBeDefined();
  });
});
