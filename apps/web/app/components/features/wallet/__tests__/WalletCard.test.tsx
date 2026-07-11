// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UserWalletResponse } from '~/services/wallet';
import type { VaultApyResponse } from '~/services/vault-apy';
import { WalletCard, fmtLoopBalance, fmtApyBps } from '../WalletCard';

afterEach(cleanup);

const { walletMock, authMock, vaultApyMock } = vi.hoisted(() => ({
  walletMock: { getMyWallet: vi.fn() },
  authMock: { isAuthenticated: true },
  // ADR 031 V6: WalletCard renders <VaultApyRow> per row, which reads
  // this hook directly — mocked at the hook boundary (same seam
  // VaultApyRow.test.tsx uses) so these balance-focused tests don't
  // also need to drive the query/auth/phase1Only gating chain.
  // Undefined vaultApy → VaultApyRow renders nothing, preserving every
  // pre-existing assertion below untouched.
  vaultApyMock: {
    vaultApy: undefined as VaultApyResponse | undefined,
    isLoading: false,
    isError: false,
  },
}));

vi.mock('~/services/wallet', () => ({
  getMyWallet: () => walletMock.getMyWallet(),
}));

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated }),
}));

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

vi.mock('~/hooks/use-vault-apy', () => ({
  useVaultApy: () => vaultApyMock,
}));

beforeEach(() => {
  walletMock.getMyWallet.mockReset();
  authMock.isAuthenticated = true;
  vaultApyMock.vaultApy = undefined;
  vaultApyMock.isLoading = false;
  vaultApyMock.isError = false;
});

function renderCard(): HTMLElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const { container } = render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <WalletCard />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return container;
}

function wallet(overrides: Partial<UserWalletResponse> = {}): UserWalletResponse {
  return {
    address: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
    provisioning: 'activated',
    balances: [{ assetCode: 'GBPLOOP', balance: '42.5000000' }],
    interestApyBps: 300,
    stale: false,
    ...overrides,
  };
}

describe('fmtLoopBalance', () => {
  it('renders a LOOP asset as plain fiat currency (no wallet jargon)', () => {
    const out = fmtLoopBalance('42.5000000', 'GBPLOOP', 'en-US');
    expect(out).toMatch(/42\.50/);
    expect(out).not.toMatch(/GBPLOOP/);
  });

  it('falls back to "<balance> <code>" for non-LOOP assets', () => {
    expect(fmtLoopBalance('1.0000000', 'XLM', 'en-US')).toBe('1.0000000 XLM');
  });

  it('returns em-dash for unparseable balances', () => {
    expect(fmtLoopBalance('garbage', 'GBPLOOP', 'en-US')).toBe('—');
  });
});

describe('fmtApyBps', () => {
  it('trims integer APYs and keeps fractional ones', () => {
    expect(fmtApyBps(300)).toBe('3');
    expect(fmtApyBps(325)).toBe('3.25');
  });
});

describe('<WalletCard />', () => {
  it('shows the LOOP balance as fiat with the interest line when activated', async () => {
    walletMock.getMyWallet.mockResolvedValue(wallet());
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/42\.50/)).toBeDefined();
    });
    expect(screen.getByText('Your Loop balance')).toBeDefined();
    expect(screen.getByText(/Earns 3% APR, paid nightly/)).toBeDefined();
    // The asset code never reaches the user.
    expect(screen.queryByText(/GBPLOOP/)).toBeNull();
  });

  it('renders every LOOP asset row when multiple are held', async () => {
    walletMock.getMyWallet.mockResolvedValue(
      wallet({
        balances: [
          { assetCode: 'GBPLOOP', balance: '42.5000000' },
          { assetCode: 'EURLOOP', balance: '7.0000000' },
        ],
      }),
    );
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/42\.50/)).toBeDefined();
    });
    expect(screen.getByText(/7\.00/)).toBeDefined();
  });

  it('omits the interest line when interestApyBps is 0', async () => {
    walletMock.getMyWallet.mockResolvedValue(wallet({ interestApyBps: 0 }));
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/42\.50/)).toBeDefined();
    });
    expect(screen.queryByText(/APR/)).toBeNull();
  });

  it('shows the non-blocking setting-up state while provisioning', async () => {
    walletMock.getMyWallet.mockResolvedValue(
      wallet({ provisioning: 'wallet_created', balances: [], address: null }),
    );
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/Setting up your wallet/)).toBeDefined();
    });
    expect(screen.getByText(/keep shopping/)).toBeDefined();
  });

  it("shows the 'none' provisioning state identically (still non-blocking)", async () => {
    walletMock.getMyWallet.mockResolvedValue(
      wallet({ provisioning: 'none', balances: [], address: null }),
    );
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/Setting up your wallet/)).toBeDefined();
    });
  });

  it('shows the zero-balance state when activated with no LOOP rows', async () => {
    walletMock.getMyWallet.mockResolvedValue(wallet({ balances: [] }));
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/No balance yet/)).toBeDefined();
    });
  });

  it('renders nothing on fetch error (endpoint may not be deployed yet)', async () => {
    walletMock.getMyWallet.mockRejectedValue(new Error('404'));
    const container = renderCard();
    await waitFor(() => {
      expect(walletMock.getMyWallet).toHaveBeenCalled();
    });
    expect(container.textContent).toBe('');
  });

  it('renders nothing (and never fetches) when signed out', () => {
    authMock.isAuthenticated = false;
    const container = renderCard();
    expect(walletMock.getMyWallet).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');
  });
});

describe('<WalletCard /> vault-APY composition (ADR 031 V6)', () => {
  it('shows the past-30-day APY + disclaimer under the matching balance row', async () => {
    walletMock.getMyWallet.mockResolvedValue(wallet());
    vaultApyMock.vaultApy = {
      assets: [
        {
          assetCode: 'GBPLOOP',
          past30dApy: 0.0312,
          past90dRange: { minApy: 0.028, maxApy: 0.035 },
        },
      ],
      disclaimerKey: 'wallet.apyDisclaimer',
    };
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/42\.50/)).toBeDefined();
    });
    expect(screen.getByText(/Past 30 days: 3\.12% APY/)).toBeDefined();
    expect(screen.getByText(/Past performance doesn't guarantee future returns/)).toBeDefined();
    // The asset code never reaches the user, even with APY shown.
    expect(screen.queryByText(/GBPLOOP/)).toBeNull();
    // Never the yield mechanism.
    expect(document.body.textContent).not.toMatch(/defindex|blend|soroban|strategy/i);
  });

  it('omits the APY line (Phase-1-gated / no data) without breaking the balance display', async () => {
    walletMock.getMyWallet.mockResolvedValue(wallet());
    // vaultApyMock.vaultApy stays undefined — same shape `useVaultApy`
    // returns while LOOP_PHASE_1_ONLY is on (its own gate disables the
    // query entirely, so data never arrives).
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/42\.50/)).toBeDefined();
    });
    expect(screen.queryByText(/APY/)).toBeNull();
  });
});
