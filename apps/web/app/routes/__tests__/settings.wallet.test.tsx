// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ApiException } from '@loop/shared';

/**
 * Service + hook mocks. Hoisted so the mock factories below can
 * reference the spies. Each test overrides `meResult` / `setResult`
 * / `isAuthenticated` to exercise the branch it cares about.
 */
const { userMock, authMock } = vi.hoisted(() => ({
  userMock: {
    me: {
      id: 'u-1',
      email: 'a@b.com',
      isAdmin: false,
      homeCurrency: 'GBP' as const,
      stellarAddress: null as string | null,
      homeCurrencyBalanceMinor: '0',
    },
    meError: null as unknown,
    setResult: null as unknown,
    setError: null as unknown,
    getMe: vi.fn(),
    setStellarAddress: vi.fn(),
  },
  authMock: {
    isAuthenticated: true,
  },
}));

vi.mock('~/services/user', () => ({
  getMe: () =>
    userMock.getMe() as Promise<{
      id: string;
      email: string;
      isAdmin: boolean;
      homeCurrency: 'USD' | 'GBP' | 'EUR';
      stellarAddress: string | null;
      homeCurrencyBalanceMinor: string;
    }>,
  setStellarAddress: (addr: string | null) => userMock.setStellarAddress(addr),
}));

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated }),
}));

// Default config — trustline issuers null so the existing tests
// don't see the new TrustlineCard. Trustline-specific tests override.
const { configMock } = vi.hoisted(() => ({
  configMock: {
    config: {
      loopAuthNativeEnabled: false,
      loopOrdersEnabled: false,
      social: {
        googleClientIdWeb: null,
        googleClientIdIos: null,
        googleClientIdAndroid: null,
        appleServiceId: null,
      },
      loopAssetIssuers: {
        USDLOOP: null as string | null,
        GBPLOOP: null as string | null,
        EURLOOP: null as string | null,
      },
    },
  },
}));
vi.mock('~/hooks/use-app-config', () => ({
  useAppConfig: () => ({ config: configMock.config, isLoading: false }),
}));

vi.mock('~/native/clipboard', () => ({
  copyToClipboard: vi.fn(async () => true),
}));

vi.mock('~/hooks/query-retry', () => ({
  shouldRetry: () => false,
}));

vi.mock('~/components/ui/Spinner', () => ({
  Spinner: () => <div data-testid="spinner" />,
}));

import SettingsWalletRoute from '../settings.wallet';

const VALID_ADDRESS = 'G' + 'A'.repeat(55);

function renderPage(): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SettingsWalletRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  userMock.me = {
    id: 'u-1',
    email: 'a@b.com',
    isAdmin: false,
    homeCurrency: 'GBP',
    stellarAddress: null,
    homeCurrencyBalanceMinor: '0',
  };
  userMock.meError = null;
  userMock.setResult = null;
  userMock.setError = null;
  authMock.isAuthenticated = true;
  userMock.getMe.mockReset();
  userMock.setStellarAddress.mockReset();
  userMock.getMe.mockImplementation(async () => {
    if (userMock.meError !== null) throw userMock.meError;
    return userMock.me;
  });
  userMock.setStellarAddress.mockImplementation(async (addr: string | null) => {
    if (userMock.setError !== null) throw userMock.setError;
    const next = userMock.setResult ?? { ...userMock.me, stellarAddress: addr };
    userMock.me = next as typeof userMock.me;
    return next;
  });
  // Reset issuer map to null for each test — trustline tests opt in.
  configMock.config.loopAssetIssuers = { USDLOOP: null, GBPLOOP: null, EURLOOP: null };
});

afterEach(cleanup);

describe('SettingsWalletRoute', () => {
  it('shows the sign-in prompt when unauthenticated', async () => {
    authMock.isAuthenticated = false;
    renderPage();
    expect(await screen.findByText(/Sign in to link a Stellar wallet/i)).toBeTruthy();
    expect(userMock.getMe).not.toHaveBeenCalled();
  });

  it('renders the empty state + asset code when no wallet is linked', async () => {
    renderPage();
    expect(await screen.findByText(/No wallet linked/i)).toBeTruthy();
    // Home currency GBP → GBPLOOP surfaced in both the header + helper.
    expect(screen.getAllByText((t) => t.includes('GBPLOOP')).length).toBeGreaterThan(0);
  });

  it('renders the linked-address card + unlink button when a wallet is already linked', async () => {
    userMock.me = {
      ...userMock.me,
      stellarAddress: 'GEXISTING' + 'B'.repeat(48),
    };
    renderPage();
    expect(await screen.findByText(/GEXISTING/i)).toBeTruthy();
    expect(screen.getByText(/Unlink wallet/i)).toBeTruthy();
  });

  it('rejects malformed addresses with an inline warning + disabled submit', async () => {
    renderPage();
    const input = (await screen.findByLabelText(/Stellar public key/i)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'not-a-pubkey' } });
    expect(screen.getByText(/doesn.+look like a Stellar public key/i)).toBeTruthy();
    const button = screen.getByRole('button', { name: /Link wallet/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('submits a valid address and updates the linked-address card', async () => {
    userMock.setResult = {
      ...userMock.me,
      stellarAddress: VALID_ADDRESS,
    };
    renderPage();
    const input = (await screen.findByLabelText(/Stellar public key/i)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: VALID_ADDRESS } });
    const button = screen.getByRole('button', { name: /Link wallet/i });
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(userMock.setStellarAddress).toHaveBeenCalledWith(VALID_ADDRESS));
    await screen.findByText(VALID_ADDRESS);
    expect(screen.getByText(/Unlink wallet/i)).toBeTruthy();
  });

  it('unlinks when the user clicks the unlink button', async () => {
    userMock.me = {
      ...userMock.me,
      stellarAddress: VALID_ADDRESS,
    };
    userMock.setResult = {
      ...userMock.me,
      stellarAddress: null,
    };
    renderPage();
    await screen.findByText(VALID_ADDRESS);
    const button = screen.getByRole('button', { name: /Unlink wallet/i });
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(userMock.setStellarAddress).toHaveBeenCalledWith(null));
    await screen.findByText(/No wallet linked/i);
  });

  it('shows an inline error when the PUT fails with ApiException', async () => {
    userMock.setError = new ApiException(400, {
      code: 'VALIDATION_ERROR',
      message: 'Invalid Stellar pubkey',
    });
    renderPage();
    const input = (await screen.findByLabelText(/Stellar public key/i)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: VALID_ADDRESS } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Link wallet/i }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Invalid Stellar pubkey');
  });

  it('trims whitespace around pasted addresses', async () => {
    userMock.setResult = { ...userMock.me, stellarAddress: VALID_ADDRESS };
    renderPage();
    const input = (await screen.findByLabelText(/Stellar public key/i)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: `  ${VALID_ADDRESS}  ` } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Link wallet/i }));
    });
    await waitFor(() => expect(userMock.setStellarAddress).toHaveBeenCalledWith(VALID_ADDRESS));
  });
});

describe('SettingsWalletRoute — trustline card', () => {
  const GBP_ISSUER = 'G' + 'B'.repeat(55);

  it('does not render the trustline card when no wallet is linked', async () => {
    configMock.config.loopAssetIssuers.GBPLOOP = GBP_ISSUER;
    // Default userMock.me has no stellarAddress.
    renderPage();
    expect(await screen.findByText(/No wallet linked/i)).toBeTruthy();
    expect(screen.queryByText(/Add a trustline/i)).toBeNull();
  });

  it('does not render the trustline card when the issuer for the user\u2019s currency is unconfigured', async () => {
    userMock.me = { ...userMock.me, stellarAddress: VALID_ADDRESS };
    configMock.config.loopAssetIssuers = {
      USDLOOP: 'G' + 'A'.repeat(55),
      GBPLOOP: null, // user is on GBP — GBPLOOP issuer missing
      EURLOOP: 'G' + 'C'.repeat(55),
    };
    renderPage();
    await screen.findByText(VALID_ADDRESS);
    expect(screen.queryByText(/Add a trustline/i)).toBeNull();
  });

  it('renders the trustline card with asset code + issuer when wallet is linked and issuer is known', async () => {
    userMock.me = { ...userMock.me, stellarAddress: VALID_ADDRESS };
    configMock.config.loopAssetIssuers.GBPLOOP = GBP_ISSUER;
    renderPage();
    // Wait for the card to appear — there's exactly one heading with
    // this prefix inside the trustline card.
    const headings = await screen.findAllByText(/Add a trustline/i);
    expect(headings.length).toBeGreaterThan(0);
    // Issuer address is rendered inside the card too. One exact
    // match; asset code (GBPLOOP) also appears in the form helper
    // text so findAllByText is more robust than getByText here.
    expect(screen.getByText(GBP_ISSUER)).toBeTruthy();
    expect(screen.getAllByText(/GBPLOOP/).length).toBeGreaterThan(0);
  });

  it('copies the issuer address to the clipboard when the Copy button is clicked', async () => {
    const clipboardModule = (await import('~/native/clipboard')) as unknown as {
      copyToClipboard: ReturnType<typeof vi.fn>;
    };
    clipboardModule.copyToClipboard.mockClear();
    userMock.me = { ...userMock.me, stellarAddress: VALID_ADDRESS };
    configMock.config.loopAssetIssuers.GBPLOOP = GBP_ISSUER;
    renderPage();
    const button = await screen.findByRole('button', { name: /Copy issuer address/i });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(clipboardModule.copyToClipboard).toHaveBeenCalledWith(GBP_ISSUER);
  });
});
