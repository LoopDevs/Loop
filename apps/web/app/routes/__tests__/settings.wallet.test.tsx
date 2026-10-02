// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ApiException } from '@loop/shared';
import type { UserAccountView, WalletLinkView } from '@loop/shared';
import type { UserMeView } from '~/services/user';

const VALID_ADDRESS = 'G' + 'A'.repeat(55);

const { userMock, authMock } = vi.hoisted(() => ({
  userMock: {
    getMe: vi.fn(),
    getMyAccount: vi.fn(),
    linkWallet: vi.fn(),
    unlinkWallet: vi.fn(),
    updateWallet: vi.fn(),
    setHomeCurrency: vi.fn(),
  },
  authMock: { isAuthenticated: true },
}));

vi.mock('~/services/user', () => ({
  getMe: () => userMock.getMe(),
  getMyAccount: () => userMock.getMyAccount(),
  linkWallet: (body: { chain: 'XLM'; address: string }) => userMock.linkWallet(body),
  unlinkWallet: (id: string) => userMock.unlinkWallet(id),
  updateWallet: (id: string, body: { autoPayout: boolean }) => userMock.updateWallet(id, body),
  setHomeCurrency: (code: 'USD' | 'GBP' | 'EUR') => userMock.setHomeCurrency(code),
}));

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated }),
}));

vi.mock('~/hooks/use-app-config', () => ({
  useAppConfig: () => ({ config: { phase1Only: false }, isLoading: false }),
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

let me: UserMeView;
let links: WalletLinkView[];

function link(overrides: Partial<WalletLinkView> = {}): WalletLinkView {
  return {
    id: 'w-1',
    chain: 'XLM',
    address: VALID_ADDRESS,
    autoPayout: true,
    status: 'active',
    created: '2026-09-23T10:00:00Z',
    removed: null,
    ...overrides,
  };
}

function account(): UserAccountView {
  return {
    id: 'acct-1',
    userId: 'ctx-1',
    wallet: [],
    savings: [],
    savingsPrincipal: [],
    pendingOperations: [],
    linkedWallets: links,
    payouts: [],
    created: '2026-09-01T00:00:00Z',
    updated: '2026-09-23T10:00:00Z',
  };
}

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
  me = { id: 'u-1', email: 'a@b.com', isAdmin: false, staffRole: null, homeCurrency: 'GBP' };
  links = [];
  authMock.isAuthenticated = true;
  for (const fn of Object.values(userMock)) fn.mockReset();
  userMock.getMe.mockImplementation(async () => me);
  userMock.getMyAccount.mockImplementation(async () => account());
  userMock.linkWallet.mockImplementation(async (body: { address: string }) => {
    links = [
      ...links.map((l) => ({ ...l, status: 'removed' as const })),
      link({ id: `w-${links.length + 1}`, address: body.address }),
    ];
    return links[links.length - 1];
  });
  userMock.unlinkWallet.mockImplementation(async (id: string) => {
    links = links.map((l) => (l.id === id ? { ...l, status: 'removed' as const } : l));
    return links.find((l) => l.id === id);
  });
  userMock.updateWallet.mockImplementation(async (id: string, body: { autoPayout: boolean }) => {
    links = links.map((l) => (l.id === id ? { ...l, autoPayout: body.autoPayout } : l));
    return links.find((l) => l.id === id);
  });
  userMock.setHomeCurrency.mockImplementation(async (code: 'USD' | 'GBP' | 'EUR') => {
    me = { ...me, homeCurrency: code };
    return me;
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
    expect(userMock.getMyAccount).not.toHaveBeenCalled();
  });

  it('renders the empty state and the held stable when no wallet is linked', async () => {
    renderPage();
    expect(await screen.findByText(/No wallet linked/i)).toBeTruthy();
    expect(screen.getAllByText((t) => t.includes('GBPLOOP')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Unlink wallet/i)).toBeNull();
  });

  it('renders the active link with copy and unlink, ignoring removed links', async () => {
    links = [link({ id: 'w-old', status: 'removed', address: 'G' + 'B'.repeat(55) }), link()];
    renderPage();
    expect(await screen.findByText(VALID_ADDRESS)).toBeTruthy();
    expect(screen.queryByText('G' + 'B'.repeat(55))).toBeNull();
    expect(screen.getByText(/Unlink wallet/i)).toBeTruthy();
    expect(screen.queryByLabelText(/Stellar public key/i)).toBeNull();
  });

  it('shows an account error when the account read fails', async () => {
    userMock.getMyAccount.mockRejectedValue(new Error('down'));
    renderPage();
    expect(await screen.findByText(/Couldn't load your wallet right now/i)).toBeTruthy();
  });

  it('keeps submit disabled until something is typed and sends whatever was typed', async () => {
    renderPage();
    const input = (await screen.findByLabelText(/Stellar public key/i)) as HTMLInputElement;
    const button = screen.getByRole('button', { name: /Link wallet/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'not-a-pubkey' } });
    expect(button.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() =>
      expect(userMock.linkWallet).toHaveBeenCalledWith({ chain: 'XLM', address: 'not-a-pubkey' }),
    );
  });

  it('links a trimmed address on XLM and shows it as the active link', async () => {
    renderPage();
    const input = (await screen.findByLabelText(/Stellar public key/i)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: `  ${VALID_ADDRESS}  ` } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Link wallet/i }));
    });
    await waitFor(() =>
      expect(userMock.linkWallet).toHaveBeenCalledWith({ chain: 'XLM', address: VALID_ADDRESS }),
    );
    await screen.findByText(VALID_ADDRESS);
    expect(screen.getByText(/Unlink wallet/i)).toBeTruthy();
    expect(screen.queryByLabelText(/Stellar public key/i)).toBeNull();
  });

  it('unlinks the active link by id', async () => {
    links = [link()];
    renderPage();
    await screen.findByText(VALID_ADDRESS);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Unlink wallet/i }));
    });
    await waitFor(() => expect(userMock.unlinkWallet).toHaveBeenCalledWith('w-1'));
    await screen.findByText(/No wallet linked/i);
    expect(screen.getByLabelText(/Stellar public key/i)).toBeTruthy();
  });

  it('copies the linked address and flips the button label', async () => {
    links = [link()];
    renderPage();
    await screen.findByText(VALID_ADDRESS);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Copy address/i }));
    });
    await waitFor(() => expect(clipboardMock.copyToClipboard).toHaveBeenCalledWith(VALID_ADDRESS));
    expect(screen.getByRole('button', { name: /Copied/i })).toBeTruthy();
  });

  it('surfaces the API message when linking fails', async () => {
    userMock.linkWallet.mockRejectedValue(
      new ApiException(400, { code: 'VALIDATION_ERROR', message: 'address: invalid' }),
    );
    renderPage();
    const input = (await screen.findByLabelText(/Stellar public key/i)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: VALID_ADDRESS } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Link wallet/i }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('address: invalid');
  });

  it('offers Payout selected and Savings disabled as coming soon', async () => {
    renderPage();
    const payout = (await screen.findByRole('radio', { name: /Payout/i })) as HTMLButtonElement;
    const savings = screen.getByRole('radio', { name: /Savings/i }) as HTMLButtonElement;
    expect(payout.getAttribute('aria-checked')).toBe('true');
    expect(savings.disabled).toBe(true);
    expect(savings.textContent).toMatch(/Coming soon/i);
  });

  it('re-enables auto payout when Payout is selected on a link that has it off', async () => {
    links = [link({ autoPayout: false })];
    renderPage();
    const payout = (await screen.findByRole('radio', { name: /Payout/i })) as HTMLButtonElement;
    expect(payout.getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      fireEvent.click(payout);
    });
    await waitFor(() =>
      expect(userMock.updateWallet).toHaveBeenCalledWith('w-1', { autoPayout: true }),
    );
    await waitFor(() =>
      expect(
        (screen.getByRole('radio', { name: /Payout/i }) as HTMLButtonElement).getAttribute(
          'aria-checked',
        ),
      ).toBe('true'),
    );
  });

  it('switches home currency and reflects the new held stable', async () => {
    renderPage();
    await screen.findByRole('radio', { name: /GBP/i });
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: /^USD/i }));
    });
    await waitFor(() => expect(userMock.setHomeCurrency).toHaveBeenCalledWith('USD'));
    await waitFor(() => {
      expect(screen.getAllByText((t) => t.includes('USDC')).length).toBeGreaterThan(0);
    });
  });

  it('renders a locked-state callout when the backend returns 409', async () => {
    userMock.setHomeCurrency.mockRejectedValue(
      new ApiException(409, {
        code: 'HOME_CURRENCY_LOCKED',
        message: 'Home currency cannot be changed after placing an order',
      }),
    );
    renderPage();
    await screen.findByRole('radio', { name: /GBP/i });
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: /^EUR/i }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/already placed an order/i);
  });
});
