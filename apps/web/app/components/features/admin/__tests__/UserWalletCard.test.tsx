// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiException, type AdminUserWalletView } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import { useUiStore } from '~/stores/ui.store';
import { UserWalletCard } from '../UserWalletCard';

afterEach(cleanup);

// ui.store resolves the initial theme via window.matchMedia at module
// import time — jsdom doesn't implement it, so stub it before any
// import pulls the store in (vi.hoisted runs pre-import).
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
});

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminUserWallet: vi.fn(),
    reprovisionAdminUserWallet: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAdminUserWallet: (userId: string) => adminMock.getAdminUserWallet(userId),
    reprovisionAdminUserWallet: (userId: string) => adminMock.reprovisionAdminUserWallet(userId),
  };
});

vi.mock('~/hooks/query-retry', () => ({
  shouldRetry: () => false,
}));

beforeEach(() => {
  adminMock.getAdminUserWallet.mockReset();
  adminMock.reprovisionAdminUserWallet.mockReset();
  useUiStore.setState({ toasts: [] });

  // jsdom doesn't ship a complete <dialog> implementation: showModal
  // and close are missing on HTMLDialogElement. Polyfill the minimum
  // surface ConfirmDialog.tsx exercises.
  const proto = HTMLDialogElement.prototype as any;
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
});

const stuckWallet: AdminUserWalletView = {
  provider: 'privy',
  walletId: 'wal-1',
  address: 'GWALLETADDR',
  provisioning: 'wallet_created',
  balances: [],
  attempts: 3,
  lastAttemptAt: '2026-06-10T09:00:00.000Z',
};

const activatedWallet: AdminUserWalletView = {
  provider: 'privy',
  walletId: 'wal-2',
  address: 'GACTIVATED',
  provisioning: 'activated',
  balances: [
    { assetCode: 'GBPLOOP', balance: '5.0000000' },
    { assetCode: 'USDLOOP', balance: '1.2500000' },
  ],
  attempts: 1,
  lastAttemptAt: '2026-06-09T12:00:00.000Z',
};

function renderCard(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <UserWalletCard userId="u-1" />
    </QueryClientProvider>,
  );
}

describe('<UserWalletCard />', () => {
  it('shows a spinner while the wallet state loads', () => {
    adminMock.getAdminUserWallet.mockReturnValue(new Promise(() => undefined));
    renderCard();
    expect(screen.getByRole('status')).toBeDefined();
  });

  it('renders an error line when the wallet fetch fails', async () => {
    adminMock.getAdminUserWallet.mockRejectedValue(
      new ApiException(503, { code: 'CIRCUIT_OPEN', message: 'down' }),
    );
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load wallet state/i)).toBeDefined();
    });
  });

  it('renders provisioning badge, telemetry, and empty balances for a stuck wallet', async () => {
    adminMock.getAdminUserWallet.mockResolvedValue(stuckWallet);
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/wallet created — not activated/i)).toBeDefined();
    });
    expect(screen.getByText('privy')).toBeDefined();
    expect(screen.getByText('GWALLETADDR')).toBeDefined();
    expect(screen.getByText('3')).toBeDefined();
    expect(screen.getByText(/No LOOP-asset balances yet/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /Re-trigger provisioning/i })).toBeDefined();
  });

  it('renders balances and hides the re-trigger button once activated', async () => {
    adminMock.getAdminUserWallet.mockResolvedValue(activatedWallet);
    renderCard();
    // Wait on the address — 'activated' also appears in the static
    // header copy, so it can't signal data arrival.
    await waitFor(() => {
      expect(screen.getByText('GACTIVATED')).toBeDefined();
    });
    expect(screen.getByText('GBPLOOP')).toBeDefined();
    expect(screen.getByText('5.0000000')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Re-trigger provisioning/i })).toBeNull();
  });

  it('confirm → reprovision service called → success toast', async () => {
    adminMock.getAdminUserWallet.mockResolvedValue(stuckWallet);
    adminMock.reprovisionAdminUserWallet.mockResolvedValue({ enqueued: true });
    renderCard();
    const trigger = await screen.findByRole('button', { name: /Re-trigger provisioning/i });
    await act(async () => {
      fireEvent.click(trigger);
    });
    // ConfirmDialog opens; submit its form (the Re-trigger confirm).
    const confirm = screen.getByRole('button', { name: 'Re-trigger' });
    const form = confirm.closest('form');
    if (form === null) throw new Error('confirm dialog form not found');
    await act(async () => {
      fireEvent.submit(form);
    });
    await waitFor(() => {
      expect(adminMock.reprovisionAdminUserWallet).toHaveBeenCalledWith('u-1');
    });
    await waitFor(() => {
      expect(
        useUiStore.getState().toasts.some((t) => /re-provisioning enqueued/i.test(t.message)),
      ).toBe(true);
    });
  });

  it('cancelling the confirm dialog does not call the service', async () => {
    adminMock.getAdminUserWallet.mockResolvedValue(stuckWallet);
    renderCard();
    const trigger = await screen.findByRole('button', { name: /Re-trigger provisioning/i });
    await act(async () => {
      fireEvent.click(trigger);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(adminMock.reprovisionAdminUserWallet).not.toHaveBeenCalled();
  });

  it('surfaces a reprovision failure as an error toast', async () => {
    adminMock.getAdminUserWallet.mockResolvedValue(stuckWallet);
    adminMock.reprovisionAdminUserWallet.mockRejectedValue(
      new ApiException(503, { code: 'CIRCUIT_OPEN', message: 'provisioning sweep offline' }),
    );
    renderCard();
    const trigger = await screen.findByRole('button', { name: /Re-trigger provisioning/i });
    await act(async () => {
      fireEvent.click(trigger);
    });
    const confirm = screen.getByRole('button', { name: 'Re-trigger' });
    const form = confirm.closest('form');
    if (form === null) throw new Error('confirm dialog form not found');
    await act(async () => {
      fireEvent.submit(form);
    });
    await waitFor(() => {
      expect(
        useUiStore
          .getState()
          .toasts.some((t) => t.type === 'error' && /provisioning sweep offline/.test(t.message)),
      ).toBe(true);
    });
  });
});
