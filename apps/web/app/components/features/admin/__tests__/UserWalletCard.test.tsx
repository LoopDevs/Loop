// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiException, type AdminUserWalletResponse } from '@loop/shared';
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
    reprovisionAdminUserWallet: (args: unknown) => adminMock.reprovisionAdminUserWallet(args),
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
  // surface ReasonDialog.tsx exercises.
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

const stuckWallet: AdminUserWalletResponse = {
  userId: 'u-1',
  provider: 'privy',
  walletId: 'wal-1',
  walletAddress: 'GWALLETADDR',
  stellarAddress: null,
  provisioning: 'wallet_created',
  provisioningAttempts: 3,
  provisioningLastAttemptAt: '2026-06-10T09:00:00.000Z',
  onChain: {
    accountExists: false,
    balances: [],
    asOf: '2026-06-11T09:00:00.000Z',
  },
};

const activatedWallet: AdminUserWalletResponse = {
  userId: 'u-1',
  provider: 'privy',
  walletId: 'wal-2',
  walletAddress: 'GACTIVATED',
  stellarAddress: null,
  provisioning: 'activated',
  provisioningAttempts: 1,
  provisioningLastAttemptAt: '2026-06-09T12:00:00.000Z',
  onChain: {
    accountExists: true,
    balances: [
      {
        assetCode: 'GBPLOOP',
        assetIssuer: 'GISSUER1',
        balanceStroops: '50000000',
        limitStroops: '9000000000000',
      },
      {
        assetCode: 'USDLOOP',
        assetIssuer: 'GISSUER2',
        balanceStroops: '12500000',
        limitStroops: '9000000000000',
      },
    ],
    asOf: '2026-06-11T09:00:00.000Z',
  },
};

/** ADR-017 {result, audit} envelope helper — matches the backend. */
function envelope<T>(result: T, replayed = false): { result: T; audit: Record<string, unknown> } {
  return {
    result,
    audit: {
      actorUserId: 'admin-1',
      actorEmail: 'admin@loop.test',
      idempotencyKey: 'k'.repeat(32),
      appliedAt: '2026-06-12T10:00:00.000Z',
      replayed,
    },
  };
}

function renderCard(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <UserWalletCard userId="u-1" />
    </QueryClientProvider>,
  );
}

/** Click re-trigger, type a reason, submit the dialog form. */
async function reprovisionWithReason(reason = 'stuck since signup — OPS-12'): Promise<void> {
  const trigger = await screen.findByRole('button', { name: /Re-trigger provisioning/i });
  await act(async () => {
    fireEvent.click(trigger);
  });
  const openDialog = await waitFor(() => {
    const d = document.querySelector('dialog[open]');
    if (!(d instanceof HTMLElement)) throw new Error('no open dialog');
    return d;
  });
  const textarea = within(openDialog).getByRole('textbox');
  await act(async () => {
    fireEvent.change(textarea, { target: { value: reason } });
  });
  const form = textarea.closest('form');
  if (form === null) throw new Error('reason dialog form not found');
  await act(async () => {
    fireEvent.submit(form);
  });
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

  it('renders provisioning badge, telemetry, and no-account state for a stuck wallet', async () => {
    adminMock.getAdminUserWallet.mockResolvedValue(stuckWallet);
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/wallet created — not activated/i)).toBeDefined();
    });
    expect(screen.getByText('privy')).toBeDefined();
    expect(screen.getByText('GWALLETADDR')).toBeDefined();
    expect(screen.getByText('3')).toBeDefined();
    expect(screen.getByText(/No on-chain account yet/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /Re-trigger provisioning/i })).toBeDefined();
  });

  it('renders stroop balances and hides the re-trigger button once activated', async () => {
    adminMock.getAdminUserWallet.mockResolvedValue(activatedWallet);
    renderCard();
    // Wait on the address — 'activated' also appears in the static
    // header copy, so it can't signal data arrival.
    await waitFor(() => {
      expect(screen.getByText('GACTIVATED')).toBeDefined();
    });
    // fmtStroops: 50000000 stroops → "5 GBPLOOP"; 12500000 → "1.25 USDLOOP".
    expect(screen.getByText('5 GBPLOOP')).toBeDefined();
    expect(screen.getByText('1.25 USDLOOP')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Re-trigger provisioning/i })).toBeNull();
  });

  it('renders the Horizon-unreachable hint when onChain is null', async () => {
    adminMock.getAdminUserWallet.mockResolvedValue({ ...stuckWallet, onChain: null });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/Horizon unreachable/i)).toBeDefined();
    });
  });

  it('reason dialog → reprovision service called with userId + reason → success toast', async () => {
    adminMock.getAdminUserWallet.mockResolvedValue(stuckWallet);
    adminMock.reprovisionAdminUserWallet.mockResolvedValue(
      envelope({
        userId: 'u-1',
        priorProvisioning: 'wallet_created',
        attempts: 0,
        requeued: true,
      }),
    );
    renderCard();
    await reprovisionWithReason();
    await waitFor(() => {
      expect(adminMock.reprovisionAdminUserWallet).toHaveBeenCalledWith({
        userId: 'u-1',
        reason: 'stuck since signup — OPS-12',
      });
    });
    await waitFor(() => {
      expect(
        useUiStore.getState().toasts.some((t) => /re-provisioning enqueued/i.test(t.message)),
      ).toBe(true);
    });
  });

  it('cancelling the reason dialog does not call the service', async () => {
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
    await reprovisionWithReason();
    await waitFor(() => {
      expect(
        useUiStore
          .getState()
          .toasts.some((t) => t.type === 'error' && /provisioning sweep offline/.test(t.message)),
      ).toBe(true);
    });
  });
});
