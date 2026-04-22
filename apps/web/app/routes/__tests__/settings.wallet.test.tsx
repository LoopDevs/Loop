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
    setHomeCurrency: vi.fn(),
    currencyError: null as unknown,
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
  setHomeCurrency: (code: 'USD' | 'GBP' | 'EUR') => userMock.setHomeCurrency(code),
}));

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated }),
}));

vi.mock('~/hooks/query-retry', () => ({
  shouldRetry: () => false,
}));

vi.mock('~/components/ui/Spinner', () => ({
  Spinner: () => <div data-testid="spinner" />,
}));

const { clipboardMock } = vi.hoisted(() => ({
  clipboardMock: {
    copyToClipboard: vi.fn(async (_: string) => true),
  },
}));

vi.mock('~/native/clipboard', () => ({
  copyToClipboard: (text: string) => clipboardMock.copyToClipboard(text),
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
  userMock.setHomeCurrency.mockReset();
  userMock.currencyError = null;
  userMock.setHomeCurrency.mockImplementation(async (code: 'USD' | 'GBP' | 'EUR') => {
    if (userMock.currencyError !== null) throw userMock.currencyError;
    const next = { ...userMock.me, homeCurrency: code };
    userMock.me = next as typeof userMock.me;
    return next;
  });
  clipboardMock.copyToClipboard.mockReset();
  clipboardMock.copyToClipboard.mockResolvedValue(true);
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

  it('copies the linked address to the clipboard and flips the button label', async () => {
    userMock.me = {
      ...userMock.me,
      stellarAddress: VALID_ADDRESS,
    };
    renderPage();
    await screen.findByText(VALID_ADDRESS);
    const button = screen.getByRole('button', { name: /Copy address/i });
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(clipboardMock.copyToClipboard).toHaveBeenCalledWith(VALID_ADDRESS));
    expect(screen.getByRole('button', { name: /Copied/i })).toBeTruthy();
  });

  it('leaves the button label alone when the clipboard write fails', async () => {
    clipboardMock.copyToClipboard.mockResolvedValueOnce(false);
    userMock.me = {
      ...userMock.me,
      stellarAddress: VALID_ADDRESS,
    };
    renderPage();
    await screen.findByText(VALID_ADDRESS);
    const button = screen.getByRole('button', { name: /Copy address/i });
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(clipboardMock.copyToClipboard).toHaveBeenCalled());
    // No switch to 'Copied' — the user sees the original label so
    // they know the gesture didn't land.
    expect(screen.getByRole('button', { name: /Copy address/i })).toBeTruthy();
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

  it('switches home currency via the picker and reflects the new asset in the header', async () => {
    renderPage();
    // Wait for the initial GBP render so the radio buttons are mounted.
    await screen.findByRole('radio', { name: /GBP/i });
    const usdButton = screen.getByRole('radio', { name: /USD/i });
    await act(async () => {
      fireEvent.click(usdButton);
    });
    await waitFor(() => expect(userMock.setHomeCurrency).toHaveBeenCalledWith('USD'));
    // Header reflects the new asset code after the mutation succeeds.
    await waitFor(() => {
      expect(screen.getAllByText((t) => t.includes('USDLOOP')).length).toBeGreaterThan(0);
    });
  });

  it('renders a locked-state callout when the backend returns 409', async () => {
    userMock.currencyError = new ApiException(409, {
      code: 'HOME_CURRENCY_LOCKED',
      message: 'Home currency cannot be changed after placing an order',
    });
    renderPage();
    await screen.findByRole('radio', { name: /GBP/i });
    const eurButton = screen.getByRole('radio', { name: /EUR/i });
    await act(async () => {
      fireEvent.click(eurButton);
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/already placed an order/i);
    expect(alert.textContent).toMatch(/Contact support/i);
  });
});
